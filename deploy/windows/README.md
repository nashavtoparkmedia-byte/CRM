# Windows supervision recipes

Two options. Pick one based on what's already installed on the host;
NSSM is recommended for unattended production, Task Scheduler is
acceptable for short-lived dev boxes.

The full topology + runbook lives in `docs/operations/deployment.md`.

---

## Option A — NSSM (recommended)

Download from <https://nssm.cc/>. Install as a service:

```cmd
:: AudioBridge
nssm install AudioBridge "C:\Program Files\nodejs\node.exe" "server.js"
nssm set AudioBridge AppDirectory "D:\Github\CRM\tools\audio-bridge-day1"
nssm set AudioBridge AppEnvironmentExtra "NODE_ENV=production" "CRM_BASE_URL=http://127.0.0.1:3002"
nssm set AudioBridge AppStdout "D:\Logs\audio-bridge.out.log"
nssm set AudioBridge AppStderr "D:\Logs\audio-bridge.err.log"
nssm set AudioBridge AppRotateFiles 1
nssm set AudioBridge AppRotateBytes 10485760
nssm set AudioBridge AppRotateSeconds 86400
nssm set AudioBridge AppExit Default Restart
nssm set AudioBridge AppRestartDelay 5000
nssm set AudioBridge AppThrottle 5000
nssm start AudioBridge

:: CRM
nssm install CRM "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next" "start"
nssm set CRM AppDirectory "D:\Github\CRM\gravity-mvp"
nssm set CRM AppEnvironmentExtra "NODE_ENV=production" "PORT=3002"
nssm set CRM AppStdout "D:\Logs\crm.out.log"
nssm set CRM AppStderr "D:\Logs\crm.err.log"
nssm set CRM AppRotateFiles 1
nssm set CRM AppRotateBytes 10485760
nssm set CRM AppRotateSeconds 86400
nssm set CRM AppExit Default Restart
nssm set CRM AppRestartDelay 5000
nssm set CRM AppThrottle 5000
nssm start CRM
```

NSSM converts the Windows service stop signal into a `CTRL+C` for the
managed process, which triggers the SIGINT handlers in both bridge
(`server.js:850`) and CRM (`instrumentation.ts:350`). The graceful
shutdown sequence documented in `deployment.md` §6 fires correctly.

Real secrets (API keys, DB connection strings) belong in `.env` files
beside the executables (`gravity-mvp/.env`, `tools/audio-bridge-day1/.env`),
NOT in `AppEnvironmentExtra`.

### Verifying

```cmd
nssm status AudioBridge          :: expect SERVICE_RUNNING
nssm status CRM
curl http://127.0.0.1:3002/api/health/infra
curl http://127.0.0.1:3030/         :: bridge HTTP root, returns simple banner
```

If a service won't stay running, check the `*.err.log` files first.

---

## Option B — Task Scheduler (built-in, lighter)

For dev or pre-production hosts where installing NSSM is overkill.
Limitations: no automatic restart-on-crash without scripting, no
log rotation. Acceptable when you can tolerate occasional manual
restart.

Sample task XML (import via `schtasks /create /xml ... /tn AudioBridge`)
lives in `audio-bridge-task.xml` next to this file. It:

- Runs at system startup as `LocalSystem`
- Working directory = bridge's source folder
- Restarts the task if it ends (Task Scheduler's «If the task fails,
  restart every: 5 minutes, Attempt to restart up to: 3 times»)
- Writes stdout/stderr to `D:\Logs\audio-bridge-task.log`

Mirror the XML for CRM by changing the working directory and command.

### Verifying

```powershell
schtasks /query /tn AudioBridge /v
Get-Content D:\Logs\audio-bridge-task.log -Tail 50
```

---

## Common pitfalls on Windows

- **Node not in `Path` for the service user.** Use the absolute path
  to `node.exe` in NSSM/Task config; don't rely on the user's `Path`.
- **WSL2 paths.** If FreeSWITCH lives in WSL and the bridge is on the
  Windows host, set `RECORDINGS_HOST_PATH` to the UNC form:
  `\\wsl.localhost\Ubuntu-24.04\var\lib\freeswitch\recordings`.
- **Long stop times.** If NSSM stop hangs, increase `AppStopMethodConsole`
  / `AppKillProcessTree` to give the SIGINT handler the full 10–15 s.
- **Antivirus blocking npm processes.** Add the project root to AV
  exclusions; otherwise on-access scanning slows `npm start` to a crawl.
