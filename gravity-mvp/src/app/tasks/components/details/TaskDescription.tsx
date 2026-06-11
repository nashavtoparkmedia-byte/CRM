'use client'

interface TaskDescriptionProps {
    description: string
}

export default function TaskDescription({ description }: TaskDescriptionProps) {
    return (
        <div>
            <h4 className="text-section-label mb-[2px]">
                Описание
            </h4>
            <p className="text-secondary-value leading-relaxed">{description}</p>
        </div>
    )
}
