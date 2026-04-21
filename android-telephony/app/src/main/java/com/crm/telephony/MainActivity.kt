package com.crm.telephony

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.crm.telephony.api.ApiResult
import com.crm.telephony.api.CrmApiClient
import com.crm.telephony.api.models.RegisterRequest
import com.crm.telephony.auth.TelephonyCredentialManager
import com.crm.telephony.service.HeartbeatService
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var credentials: TelephonyCredentialManager
    private lateinit var apiClient: CrmApiClient

    private lateinit var urlInput: EditText
    private lateinit var statusText: TextView
    private lateinit var registerButton: Button
    private lateinit var permissionButton: Button
    private lateinit var serviceButton: Button

    private val requiredPermissions = buildList {
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.READ_CALL_LOG)
        add(Manifest.permission.CALL_PHONE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    private var startServiceAfterPermissions = false
    private var deviceJustRegistered = false
    private var serviceLaunched = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val allGranted = results.all { it.value }
        Log.d(TAG, "permissionCallback: allGranted=$allGranted startServiceAfter=$startServiceAfterPermissions deviceJustRegistered=$deviceJustRegistered isRegistered=${credentials.isRegistered()}")
        if (allGranted) {
            Toast.makeText(this, "Разрешения получены", Toast.LENGTH_SHORT).show()
            if (startServiceAfterPermissions && (deviceJustRegistered || credentials.isRegistered())) {
                startServiceAfterPermissions = false
                Log.d(TAG, "permissionCallback → launchHeartbeatService")
                launchHeartbeatService()
            }
        } else {
            startServiceAfterPermissions = false
            Toast.makeText(this, "Некоторые разрешения отклонены", Toast.LENGTH_LONG).show()
        }
        updateStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        credentials = TelephonyCredentialManager(this)
        apiClient = CrmApiClient(credentials)

        urlInput = findViewById(R.id.urlInput)
        statusText = findViewById(R.id.statusText)
        registerButton = findViewById(R.id.registerButton)
        permissionButton = findViewById(R.id.permissionButton)
        serviceButton = findViewById(R.id.serviceButton)

        // Restore saved URL
        credentials.getServerUrl()?.let { urlInput.setText(it) }

        // Detect if service was already running (e.g. after screen rotation or app reopen)
        serviceLaunched = isServiceRunning()

        registerButton.setOnClickListener { onRegister() }
        permissionButton.setOnClickListener { requestPermissions() }
        serviceButton.setOnClickListener { toggleService() }

        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun onRegister() {
        val url = urlInput.text.toString().trim()
        if (url.isBlank()) {
            Toast.makeText(this, "Введите URL сервера", Toast.LENGTH_SHORT).show()
            return
        }

        credentials.setServerUrl(url)

        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}"

        registerButton.isEnabled = false
        registerButton.text = "Регистрация..."

        lifecycleScope.launch {
            val result = apiClient.register(RegisterRequest(
                androidId = androidId,
                name = deviceName,
                appVersion = BuildConfig.VERSION_NAME,
            ))

            when (result) {
                is ApiResult.Success -> {
                    val data = result.data
                    Log.d(TAG, "register success: deviceId=${data.deviceId} hasSecret=${data.secret != null} isNew=${data.isNew}")
                    if (data.secret != null) {
                        val stored = credentials.store(data.deviceId, data.secret)
                        Log.d(TAG, "credentials.store commit=$stored isRegistered=${credentials.isRegistered()}")
                        deviceJustRegistered = stored
                        Toast.makeText(this@MainActivity, "Устройство зарегистрировано", Toast.LENGTH_SHORT).show()
                    } else {
                        Log.w(TAG, "register returned no secret — cannot authenticate heartbeat")
                        Toast.makeText(this@MainActivity, "Устройство уже зарегистрировано", Toast.LENGTH_SHORT).show()
                    }
                    autoStartServiceIfReady()
                }
                is ApiResult.Error -> {
                    Toast.makeText(this@MainActivity, "Ошибка: ${result.message}", Toast.LENGTH_LONG).show()
                }
                is ApiResult.NetworkError -> {
                    Toast.makeText(this@MainActivity, "Нет связи с сервером", Toast.LENGTH_LONG).show()
                }
                is ApiResult.Unauthorized -> {
                    Toast.makeText(this@MainActivity, "Unauthorized", Toast.LENGTH_LONG).show()
                }
            }

            registerButton.isEnabled = true
            registerButton.text = "Зарегистрировать"
            updateStatus()
        }
    }

    private fun requestPermissions() {
        permissionLauncher.launch(requiredPermissions)
    }

    private fun toggleService() {
        if (!credentials.isRegistered()) {
            Toast.makeText(this, "Сначала зарегистрируйте устройство", Toast.LENGTH_SHORT).show()
            return
        }
        if (!hasAllPermissions()) {
            Toast.makeText(this, "Сначала дайте разрешения", Toast.LENGTH_SHORT).show()
            return
        }
        launchHeartbeatService()
    }

    private fun launchHeartbeatService() {
        Log.d(TAG, "launchHeartbeatService: calling startForegroundService")
        try {
            val intent = Intent(this, HeartbeatService::class.java)
            startForegroundService(intent)
            serviceLaunched = true
            Log.d(TAG, "launchHeartbeatService: startForegroundService OK")
        } catch (e: Exception) {
            Log.e(TAG, "launchHeartbeatService: FAILED", e)
            Toast.makeText(this, "Ошибка запуска: ${e.message}", Toast.LENGTH_LONG).show()
        }
        updateStatus()
    }

    private fun autoStartServiceIfReady() {
        val registered = deviceJustRegistered || credentials.isRegistered()
        val permsOk = hasAllPermissions()
        Log.d(TAG, "autoStart: registered=$registered (flag=$deviceJustRegistered prefs=${credentials.isRegistered()}) permsOk=$permsOk")
        if (!registered) {
            Log.w(TAG, "autoStart: SKIP — not registered")
            return
        }
        if (permsOk) {
            Log.d(TAG, "autoStart → launchHeartbeatService")
            launchHeartbeatService()
        } else {
            Log.d(TAG, "autoStart → requesting permissions (will launch after grant)")
            startServiceAfterPermissions = true
            permissionLauncher.launch(requiredPermissions)
        }
    }

    private fun hasAllPermissions(): Boolean = requiredPermissions.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun isServiceRunning(): Boolean {
        val manager = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
        @Suppress("DEPRECATION")
        return manager.getRunningServices(Int.MAX_VALUE).any {
            it.service.className == HeartbeatService::class.java.name
        }
    }

    private fun updateStatus() {
        val lines = mutableListOf<String>()

        val hasUrl = !credentials.getServerUrl().isNullOrBlank()
        val registered = deviceJustRegistered || credentials.isRegistered()
        val permsOk = hasAllPermissions()
        val serviceRunning = serviceLaunched || isServiceRunning()

        // ─── Status block ───
        lines.add("─── Статус ───")
        lines.add("Сервер: ${credentials.getServerUrl() ?: "не настроен"}")
        lines.add("Устройство: ${if (registered) "зарегистрировано ✓" else "не зарегистрировано"}")
        lines.add("Device ID: ${credentials.getDeviceId() ?: "—"}")
        lines.add("Сервис: ${if (serviceRunning) "работает ✓" else "остановлен"}")

        // ─── Permissions block ───
        lines.add("")
        lines.add("─── Разрешения ───")
        for (perm in requiredPermissions) {
            val granted = ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
            val name = perm.substringAfterLast('.')
            lines.add("$name: ${if (granted) "✓" else "✗"}")
        }

        // ─── Action guidance ───
        lines.add("")
        lines.add("─── Действия ───")
        when {
            !hasUrl -> {
                lines.add("Введите URL сервера")
            }
            !registered -> {
                lines.add("Нажмите «Зарегистрировать»")
            }
            startServiceAfterPermissions -> {
                lines.add("Запускаем сервис...")
            }
            !permsOk -> {
                lines.add("Выдайте разрешения")
            }
            serviceRunning -> {
                lines.add("Всё работает. Heartbeat активен.")
            }
            else -> {
                lines.add("Нажмите «Запустить сервис»")
            }
        }

        statusText.text = lines.joinToString("\n")

        // ─── Button states ───
        registerButton.isEnabled = true
        serviceButton.isEnabled = registered && permsOk && !serviceRunning
        serviceButton.text = if (serviceRunning) "Сервис работает" else "Запустить сервис"
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
