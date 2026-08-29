// Compatibility entrypoint. The browser-audio capability is owned by Calling.
export {
    enableCallAlertAudio,
    getCallAlertAudioStatus,
    startIncomingRingtone,
    subscribeCallAlertAudioStatus,
    type ActiveRingtone,
    type CallAlertAudioStatus,
} from '@/modules/calling/public/v1/call-alert-audio'
