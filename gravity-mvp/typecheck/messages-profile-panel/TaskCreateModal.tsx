interface TaskCreateModalProps {
  driverId?: string
  contactId?: string
  driverName: string
  source: string
  chatContext: {
    chatId: string
  }
  onClose: () => void
}

export default function TaskCreateModal(_props: TaskCreateModalProps) {
  void _props
  return null
}
