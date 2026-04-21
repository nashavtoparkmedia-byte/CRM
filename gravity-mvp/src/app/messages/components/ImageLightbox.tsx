"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { X, ZoomIn, ZoomOut, RotateCcw, Download, ChevronLeft, ChevronRight } from "lucide-react"

interface ImageLightboxProps {
    images: string[]
    initialIndex: number
    onClose: () => void
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25

export default function ImageLightbox({ images, initialIndex, onClose }: ImageLightboxProps) {
    const [currentIndex, setCurrentIndex] = useState(initialIndex)
    const [zoom, setZoom] = useState(1)
    const [position, setPosition] = useState({ x: 0, y: 0 })
    const [isDragging, setIsDragging] = useState(false)
    const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 })
    const containerRef = useRef<HTMLDivElement>(null)

    const src = images[currentIndex] || ''
    const hasPrev = currentIndex > 0
    const hasNext = currentIndex < images.length - 1

    const resetView = () => { setZoom(1); setPosition({ x: 0, y: 0 }) }

    const goNext = useCallback(() => {
        if (currentIndex < images.length - 1) {
            setCurrentIndex(i => i + 1)
            resetView()
        }
    }, [currentIndex, images.length])

    const goPrev = useCallback(() => {
        if (currentIndex > 0) {
            setCurrentIndex(i => i - 1)
            resetView()
        }
    }, [currentIndex])

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
            if (e.key === "ArrowLeft") goPrev()
            if (e.key === "ArrowRight") goNext()
            if (e.key === "+" || e.key === "=") setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX))
            if (e.key === "-") setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN))
            if (e.key === "0") resetView()
        }
        document.addEventListener("keydown", handleKey)
        return () => document.removeEventListener("keydown", handleKey)
    }, [onClose, goNext, goPrev])

    // Mouse wheel zoom
    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault()
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
        setZoom(z => {
            const newZoom = Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
            if (newZoom <= 1) setPosition({ x: 0, y: 0 })
            return newZoom
        })
    }, [])

    // Drag to pan when zoomed
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (zoom <= 1) return
        e.preventDefault()
        setIsDragging(true)
        dragStart.current = { x: e.clientX, y: e.clientY, posX: position.x, posY: position.y }
    }, [zoom, position])

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging) return
        const dx = e.clientX - dragStart.current.x
        const dy = e.clientY - dragStart.current.y
        setPosition({ x: dragStart.current.posX + dx, y: dragStart.current.posY + dy })
    }, [isDragging])

    const handleMouseUp = useCallback(() => {
        setIsDragging(false)
    }, [])

    // Click on backdrop to close (not on image or arrows)
    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === containerRef.current) {
            onClose()
        }
    }

    const handleDownload = async () => {
        try {
            const response = await fetch(src)
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'image.jpg'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        } catch {
            window.open(src, '_blank')
        }
    }

    const zoomPercent = Math.round(zoom * 100)

    return (
        <div className="fixed inset-0 z-[200] flex flex-col animate-in fade-in duration-150">
            {/* Dark backdrop */}
            <div className="absolute inset-0 bg-black/85" />

            {/* Top bar */}
            <div className="relative z-10 flex items-center justify-between px-4 h-[48px] shrink-0">
                <div className="text-white/60 text-[13px] font-medium">
                    {images.length > 1 ? `Фото ${currentIndex + 1} из ${images.length}` : 'Фото'}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleDownload}
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                        title="Скачать"
                    >
                        <Download size={18} />
                    </button>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                        title="Закрыть (Esc)"
                    >
                        <X size={20} />
                    </button>
                </div>
            </div>

            {/* Image area */}
            <div
                ref={containerRef}
                className={`flex-1 flex items-center justify-center overflow-hidden relative ${
                    zoom > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
                }`}
                onClick={handleBackdropClick}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                {/* Left arrow */}
                {hasPrev && (
                    <button
                        onClick={(e) => { e.stopPropagation(); goPrev() }}
                        className="absolute left-3 z-20 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white/80 hover:text-white transition-colors"
                        title="Назад (←)"
                    >
                        <ChevronLeft size={24} />
                    </button>
                )}

                <img
                    src={src}
                    alt="фото"
                    className="max-w-[90vw] max-h-[80vh] object-contain select-none"
                    style={{
                        transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                        transition: isDragging ? 'none' : 'transform 0.15s ease',
                    }}
                    draggable={false}
                />

                {/* Right arrow */}
                {hasNext && (
                    <button
                        onClick={(e) => { e.stopPropagation(); goNext() }}
                        className="absolute right-3 z-20 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white/80 hover:text-white transition-colors"
                        title="Вперёд (→)"
                    >
                        <ChevronRight size={24} />
                    </button>
                )}
            </div>

            {/* Bottom zoom controls */}
            <div className="relative z-10 flex items-center justify-center gap-3 h-[56px] shrink-0">
                <button
                    onClick={() => setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN))}
                    disabled={zoom <= ZOOM_MIN}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                    title="Уменьшить (−)"
                >
                    <ZoomOut size={18} />
                </button>

                {/* Zoom slider */}
                <div className="flex items-center gap-2.5 w-[200px]">
                    <input
                        type="range"
                        min={ZOOM_MIN * 100}
                        max={ZOOM_MAX * 100}
                        step={ZOOM_STEP * 100}
                        value={zoom * 100}
                        onChange={(e) => {
                            const newZoom = Number(e.target.value) / 100
                            setZoom(newZoom)
                            if (newZoom <= 1) setPosition({ x: 0, y: 0 })
                        }}
                        className="flex-1 h-1 accent-white/80 cursor-pointer"
                        style={{
                            background: `linear-gradient(to right, rgba(255,255,255,0.7) ${((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100}%, rgba(255,255,255,0.2) 0%)`,
                            borderRadius: 4,
                            WebkitAppearance: 'none',
                            appearance: 'none',
                        }}
                    />
                    <span className="text-white/60 text-[12px] font-mono w-[40px] text-center">
                        {zoomPercent}%
                    </span>
                </div>

                <button
                    onClick={() => setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX))}
                    disabled={zoom >= ZOOM_MAX}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                    title="Увеличить (+)"
                >
                    <ZoomIn size={18} />
                </button>

                <div className="w-px h-5 bg-white/20 mx-1" />

                <button
                    onClick={resetView}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                    title="Сбросить (0)"
                >
                    <RotateCcw size={16} />
                </button>
            </div>
        </div>
    )
}
