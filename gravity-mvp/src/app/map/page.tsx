import React from "react";

export default function MapStubPage() {
  return (
    <div className="flex h-[calc(100vh-theme(spacing.16))] w-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
      <div className="mb-4 rounded-full bg-muted p-4">
        {/* Simple placeholder icon if needed, but since we don't know what icons are available in this specific isolated file, we can just use an emoji or text for now, but lucide-react is used in the project */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground/50"
        >
          <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" />
          <path d="M15 5.764v15" />
          <path d="M9 3.236v15" />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-foreground">
        Раздел временно недоступен
      </h2>
      <p className="max-w-md text-sm">
        Раздел "Карта" был скрыт из меню и временно недоступен для использования. Пожалуйста, вернитесь на главную страницу или выберите другой раздел в меню слева.
      </p>
    </div>
  );
}
