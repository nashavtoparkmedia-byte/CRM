package ru.yokoone.crm.shell.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * The provider adapter, and nothing else.
 *
 * Every line here is translation: a RemoteMessage becomes the data map the
 * product path already understands, and a rotated token becomes a call into the
 * registration state machine. There is no validation, no deduplication, no
 * notification building and no decision of any kind in this class, because the
 * deterministic acceptance path enters at RemotePushHandler rather than here —
 * and a second implementation behind a provider callback would be exactly the
 * code that acceptance could not reach.
 *
 * Firebase only ever calls this when a default FirebaseApp exists, which in
 * this repository means only when an Owner has supplied an external
 * google-services.json. Without it the class is dead weight in the artifact and
 * the shell behaves as it did before push.
 */
class PushMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        RemotePushHandler.handle(applicationContext, message.data)
    }

    override fun onNewToken(token: String) {
        PushRegistration.onNewToken(applicationContext, token)
    }
}
