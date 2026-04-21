# Android Telephony Agent — MVP Spec

## 1. Backend API Contract

Base URL: `{CRM_SERVER}/api/telephony`

### 1.1 POST /devices/register

Auth: none (bootstrap endpoint).

**Request:**
```json
{
  "androidId": "a1b2c3d4e5f6",
  "name": "Samsung Galaxy A15",
  "phoneNumber": "89001234567",
  "simOperator": "Beeline",
  "appVersion": "1.0.0"
}
```

**Response 200 (new device):**
```json
{
  "deviceId": "cmnqct91f000rvp8wlzgchtsp",
  "secret": "eec5ea1a55a0e6044553722149f014ba...3ec113",
  "isNew": true
}
```

**Response 200 (existing active device):**
```json
{
  "deviceId": "cmnqct91f000rvp8wlzgchtsp",
  "isNew": false
}
```
No secret returned for existing active device — app must already have it stored.

**Response 200 (reactivated after revoke):**
```json
{
  "deviceId": "cmnqct91f000rvp8wlzgchtsp",
  "secret": "new_secret_value...",
  "isNew": false
}
```
Old secret invalidated. App must replace stored secret.

**Errors:**
| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"androidId and name are required"}` | Missing fields |
| 400 | `{"error":"invalid_android_id"}` | androidId > 128 chars |
| 429 | `{"error":"rate_limit_exceeded"}` | > 10 calls/hour from same IP |

**Android behavior:**
- Call on first launch and on every app update (appVersion changes).
- If response has `secret` field → store it, replacing any previous value.
- If response has no `secret` → use previously stored secret.
- If stored secret returns 401 on heartbeat → re-register (device was revoked and needs reactivation).

---

### 1.2 POST /devices/heartbeat

Auth: `Authorization: Bearer {secret}`

**Request:**
```json
{
  "batteryLevel": 85,
  "signalStrength": -75
}
```

**Response 200:**
```json
{
  "ok": true,
  "commands": [
    {
      "commandId": "cmnqd1abc...",
      "type": "call",
      "payload": {
        "phoneNumber": "+79221234567",
        "contactId": "cmnqctoz..."
      }
    }
  ]
}
```

`commands` — array, usually empty. Non-empty = CRM operator requested an action.

**Errors:**
| Code | Body | Cause |
|------|------|-------|
| 401 | `{"error":"unauthorized"}` | Invalid/revoked token |

**Android behavior:**
- Send every 60 seconds from foreground service.
- On 401 → trigger re-register flow.
- Process returned commands immediately (see section 2.5).

---

### 1.3 POST /events/call

Auth: `Authorization: Bearer {secret}`

**Request (ringing):**
```json
{
  "eventType": "ringing",
  "direction": "inbound",
  "phoneNumber": "+79221234567",
  "androidCallId": "android_call_001",
  "timestamp": "2026-04-08T18:05:00.000Z"
}
```

**Response 200:**
```json
{
  "callSessionId": "cmnqcth77...",
  "contactId": "cmnqctoz...",
  "contactName": "Иван Петров"
}
```
`contactId`/`contactName` — null if unknown number. Use for caller ID overlay.

**Request (answered):**
```json
{
  "eventType": "answered",
  "direction": "inbound",
  "phoneNumber": "+79221234567",
  "callSessionId": "cmnqcth77...",
  "androidCallId": "android_call_001",
  "timestamp": "2026-04-08T18:05:05.000Z"
}
```

**Request (ended):**
```json
{
  "eventType": "ended",
  "direction": "inbound",
  "phoneNumber": "+79221234567",
  "callSessionId": "cmnqcth77...",
  "androidCallId": "android_call_001",
  "timestamp": "2026-04-08T18:05:50.000Z",
  "duration": 45,
  "disposition": "answered"
}
```
`disposition` values: `answered`, `missed`, `busy`, `rejected`, `no_answer`

**Response 200 (ended):**
```json
{
  "callSessionId": "cmnqcth77...",
  "chatId": "cmnqctoz...",
  "messageId": "cmnqctp00...",
  "contactId": "cmnqctoz..."
}
```

**Idempotency:**
- Safe to retry any event. Server deduplicates by:
  1. `callSessionId` (primary)
  2. `deviceId + androidCallId` (secondary)
  3. `deviceId + phoneNumber + status + 5min window` (fallback)
- Idempotent response includes `"idempotent": true`.

**Errors:**
| Code | Body | When |
|------|------|------|
| 400 | `invalid_phone_number` | Phone not parseable |
| 400 | `invalid_timestamp` | Not valid ISO 8601 |
| 400 | `disposition_required` | ended without disposition |
| 400 | `invalid_duration` | duration < 0 |
| 401 | `unauthorized` | Bad token |
| 404 | `call_session_not_found` | answered without prior ringing |

**Recovery:** If app restarts mid-call and has no `callSessionId`, send `ended` directly. Server creates a recovery session automatically.

---

### 1.4 POST /commands/{id}/confirm

Auth: `Authorization: Bearer {secret}`

**Request:**
```json
{
  "success": true
}
```
Or on failure:
```json
{
  "success": false,
  "failReason": "intent_failed"
}
```

**Response 200:**
```json
{ "ok": true }
```

---

## 2. Android MVP Implementation Plan

### 2.1 Module: Auth & Storage

**Responsibilities:**
- First launch: POST /devices/register with `Settings.Secure.ANDROID_ID` + device model name
- Store `deviceId` + `secret` in EncryptedSharedPreferences (AndroidX Security)
- Provide `secret` to all other modules via singleton accessor
- Handle 401 on any request → clear stored secret → re-register

**Key class:** `TelephonyCredentialManager`

```kotlin
class TelephonyCredentialManager(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(...)
    
    fun getSecret(): String?
    fun getDeviceId(): String?
    fun store(deviceId: String, secret: String)
    fun clear()
    fun isRegistered(): Boolean
}
```

**Configuration:** Server URL stored in app settings, entered by user on first launch or hardcoded for internal deployment.

---

### 2.2 Module: Call State Listener

**Responsibilities:**
- Listen to phone call state changes via `TelephonyManager`
- Map Android states to CRM events
- Queue events for sending via EventSender

**Permissions:** `READ_PHONE_STATE`, `READ_CALL_LOG`

**State machine:**

```
                    ┌─────────────────────────┐
                    │      IDLE (no call)      │
                    └─────────┬───────────────-┘
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
         RINGING         OFFHOOK         OFFHOOK
      (incoming)     (outgoing, known)  (outgoing, unknown)
           │              │                  │
           │         POST ringing        skip ringing
           │         POST answered       wait for IDLE
     POST ringing         │                  │
           │              ▼                  ▼
           ▼           IDLE              IDLE
        OFFHOOK     query CallLog      query CallLog
     POST answered  POST ended         POST ended (recovery)
           │
           ▼
         IDLE
      query CallLog
      POST ended
```

**Key class:** `CallStateTracker`

```kotlin
class CallStateTracker(
    private val eventSender: EventSender,
    private val credentialManager: TelephonyCredentialManager
) {
    private var currentCallSessionId: String? = null
    private var currentDirection: String? = null
    private var currentNumber: String? = null
    private var ringingTimestamp: Long = 0
    
    fun onCallStateChanged(state: Int, phoneNumber: String?) {
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> handleRinging(phoneNumber)
            TelephonyManager.CALL_STATE_OFFHOOK -> handleOffhook(phoneNumber)
            TelephonyManager.CALL_STATE_IDLE -> handleIdle()
        }
    }
}
```

**CallLog query (on IDLE):**
```kotlin
// Wait 500ms for CallLog to update
Handler(Looper.getMainLooper()).postDelayed({
    val cursor = contentResolver.query(
        CallLog.Calls.CONTENT_URI,
        arrayOf(CallLog.Calls.DURATION, CallLog.Calls.TYPE, CallLog.Calls.NUMBER),
        null, null,
        "${CallLog.Calls.DATE} DESC"
    )
    // Take first entry, map TYPE to disposition
}, 500)
```

**Disposition mapping:**
| CallLog.Calls.TYPE | disposition |
|--------------------|------------|
| INCOMING_TYPE, duration > 0 | `answered` |
| INCOMING_TYPE, duration = 0 | `missed` |
| OUTGOING_TYPE, duration > 0 | `answered` |
| OUTGOING_TYPE, duration = 0 | `no_answer` |
| MISSED_TYPE | `missed` |
| REJECTED_TYPE | `rejected` |

---

### 2.3 Module: Event Sender

**Responsibilities:**
- HTTP client for all CRM API calls
- Offline queue with retry
- Auth header injection
- 401 handling → credential refresh

**Key class:** `EventSender`

```kotlin
class EventSender(
    private val credentialManager: TelephonyCredentialManager,
    private val serverUrl: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    
    private val pendingQueue = ConcurrentLinkedQueue<PendingEvent>()
    
    suspend fun sendCallEvent(event: CallEvent): CallEventResponse?
    suspend fun sendHeartbeat(telemetry: Telemetry): HeartbeatResponse?
    fun enqueue(event: PendingEvent)  // offline fallback
    suspend fun flushQueue()          // retry pending
}
```

**Retry policy:**
- Network error → enqueue to `pendingQueue`, retry on next heartbeat cycle
- 401 → trigger re-register, do NOT retry until new secret obtained
- 400 → log error, discard event (not retryable)
- 500 → enqueue, retry up to 3 times with 5s/15s/30s backoff

**Offline queue:**
- Store in Room database (survives process death)
- Max 100 events (oldest dropped first)
- Flush on: heartbeat success, network connectivity restored
- Events ordered by timestamp

---

### 2.4 Module: Heartbeat Service

**Responsibilities:**
- Foreground service with persistent notification
- Send heartbeat every 60 seconds
- Flush offline event queue on each heartbeat
- Process returned commands

**Key class:** `HeartbeatService extends Service`

```kotlin
class HeartbeatService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val interval = 60_000L
    
    override fun onStartCommand(...): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        scheduleHeartbeat()
        return START_STICKY
    }
    
    private fun scheduleHeartbeat() {
        handler.postDelayed({
            scope.launch {
                eventSender.flushQueue()
                val response = eventSender.sendHeartbeat(getTelemetry())
                response?.commands?.forEach { processCommand(it) }
            }
            scheduleHeartbeat()
        }, interval)
    }
}
```

**Notification:** Persistent notification "CRM Телефония активна" with device status.

---

### 2.5 Module: Command Executor

**Responsibilities:**
- Process commands from heartbeat response
- Execute calls via Intent.ACTION_CALL
- Confirm execution back to CRM

**Flow:**
```
heartbeat response → command {type: "call", payload: {phoneNumber}} →
  1. Intent.ACTION_CALL with tel:phoneNumber
  2. Wait for OFFHOOK state (max 10s)
  3. If OFFHOOK detected → POST /commands/{id}/confirm {success: true}
  4. If timeout or error → POST /commands/{id}/confirm {success: false, failReason: "..."}
```

**Permission:** `CALL_PHONE`

`executed` means: Intent launched AND CallStateTracker detected OFFHOOK. It does NOT mean the remote party answered.

---

## 3. Implementation Steps

| Step | What | Depends on | Estimated effort |
|------|------|------------|-----------------|
| 1 | Project setup: Kotlin, Gradle, AndroidX, OkHttp, Room | — | 2h |
| 2 | TelephonyCredentialManager + server URL config screen | — | 3h |
| 3 | EventSender: HTTP client + auth + error handling | Step 2 | 4h |
| 4 | POST /devices/register flow + first launch UX | Steps 2-3 | 3h |
| 5 | HeartbeatService: foreground service + 60s loop | Steps 3-4 | 4h |
| 6 | CallStateTracker: PHONE_STATE listener + state machine | Step 3 | 6h |
| 7 | CallLog query + disposition mapping | Step 6 | 3h |
| 8 | Integration: CallStateTracker → EventSender → API | Steps 5-7 | 4h |
| 9 | Offline queue: Room persistence + retry | Step 3 | 4h |
| 10 | Command executor: call intent + confirm | Step 5 | 3h |
| 11 | Permissions flow: runtime request + rationale UI | Steps 6-7 | 2h |
| 12 | Battery optimization whitelist prompt | Step 5 | 1h |
| 13 | End-to-end testing with CRM backend | All | 4h |

---

## 4. Blockers & Platform Risks

### 4.1 Background Execution

| Risk | Impact | Mitigation |
|------|--------|------------|
| Doze mode kills heartbeat | Device appears offline in CRM | Foreground service with notification exempt from Doze |
| OEM battery optimization (Xiaomi MIUI, Huawei EMUI, Samsung) | Service killed after screen off | Prompt user to whitelist app in battery settings; guide per OEM |
| Android 12+ foreground service restrictions | Service may not start from background | Use `FOREGROUND_SERVICE_PHONE_CALL` type; start from activity or boot receiver |

**Mitigation checklist for user:**
1. Disable battery optimization for app
2. Lock app in recent apps (Xiaomi: lock icon)
3. Enable "auto-start" on MIUI/EMUI
4. Don't force-stop app

### 4.2 Permissions

| Permission | Level | Risk |
|------------|-------|------|
| `READ_PHONE_STATE` | Runtime (dangerous) | Required for call state. Denied = app non-functional |
| `READ_CALL_LOG` | Runtime (dangerous) + Google Play restricted | Required for duration/disposition. Play Console declaration needed |
| `CALL_PHONE` | Runtime (dangerous) | Only for outbound command execution. App works without it (commands fail) |
| `FOREGROUND_SERVICE` | Normal | Auto-granted |
| `FOREGROUND_SERVICE_PHONE_CALL` | Normal (Android 14+) | Declare in manifest |
| `RECEIVE_BOOT_COMPLETED` | Normal | Auto-start after reboot |

**Google Play declaration for READ_CALL_LOG:**
Must submit a Permissions Declaration Form explaining business use case. Internal/sideloaded apps bypass this requirement.

### 4.3 Process Death

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| App killed during active call | `answered` and `ended` events lost | On restart: query CallLog for recent entries, send recovery `ended` for any unmatched calls |
| HeartbeatService killed | CRM marks device offline after 90s | `START_STICKY` restarts service; boot receiver restarts on reboot |
| Credential loss (rare, factory reset) | 401 on all requests | Re-register flow triggers automatically |

**Recovery flow on app restart:**
```kotlin
fun recoverAfterRestart() {
    val lastKnownCallTime = prefs.getLong("last_ended_timestamp", 0)
    val recentCalls = queryCallLog(since = lastKnownCallTime)
    for (call in recentCalls) {
        if (!wasAlreadySent(call)) {
            eventSender.enqueue(buildRecoveryEndedEvent(call))
        }
    }
    eventSender.flushQueue()
}
```

### 4.4 Network

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| No internet during call | Events not sent in realtime | Offline queue (Room DB), flush on connectivity restore |
| Slow network | Heartbeat timeout | 10s connect timeout, 30s read timeout. Heartbeat failure is non-fatal |
| Server unreachable | All events queued | Queue up to 100 events. Oldest dropped. Retry on next heartbeat cycle |

### 4.5 Edge Cases

| Case | Behavior |
|------|----------|
| Dual SIM | `TelephonyManager` reports state for default SIM. For dual-SIM tracking need `SubscriptionManager` — not in MVP |
| VoLTE/WiFi calling | Same PHONE_STATE events, transparent to app |
| Conference call | Multiple OFFHOOK without IDLE between them — not handled in MVP, second call ignored |
| Call forwarding | Forwarded call not detected by PHONE_STATE — not in scope |
| Number unknown on OFFHOOK (outgoing) | Skip ringing, wait for IDLE, send recovery ended from CallLog |
| App installed but no permissions | Show rationale screen, re-prompt. Service does not start until granted |

---

## 5. Tech Stack

| Component | Library |
|-----------|---------|
| Language | Kotlin |
| Min SDK | 26 (Android 8.0) |
| HTTP | OkHttp 4 + kotlinx.serialization |
| Local storage | EncryptedSharedPreferences + Room |
| Background | Foreground Service (START_STICKY) |
| Permissions | AndroidX Activity Result API |
| Build | Gradle KTS |

---

## 6. Project Structure

```
app/
├── src/main/
│   ├── java/com/crm/telephony/
│   │   ├── TelephonyApp.kt              // Application class
│   │   ├── MainActivity.kt              // Config screen + permission flow
│   │   ├── auth/
│   │   │   └── TelephonyCredentialManager.kt
│   │   ├── api/
│   │   │   ├── CrmApiClient.kt          // OkHttp wrapper
│   │   │   ├── EventSender.kt           // Queue + retry
│   │   │   └── models/                  // Request/Response DTOs
│   │   ├── call/
│   │   │   ├── CallStateTracker.kt      // PHONE_STATE listener
│   │   │   ├── CallLogReader.kt         // CallLog query + mapping
│   │   │   └── CommandExecutor.kt       // Outbound call commands
│   │   ├── service/
│   │   │   ├── HeartbeatService.kt      // Foreground service
│   │   │   └── BootReceiver.kt          // Auto-start on reboot
│   │   └── db/
│   │       ├── EventDatabase.kt         // Room DB
│   │       └── PendingEventDao.kt       // Offline queue DAO
│   └── AndroidManifest.xml
```
