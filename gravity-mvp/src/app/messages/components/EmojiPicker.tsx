"use client"

import { useEffect, useRef, useState } from "react"
import { Clock, Smile, Dog, Utensils, Plane, Trophy, Hash, X } from "lucide-react"

const RECENT_KEY = 'crm_recent_emojis'
const MAX_RECENT = 24

const CATEGORIES: { id: string; label: string; icon: React.ReactNode; emojis: string[] }[] = [
    {
        id: 'recent', label: 'Недавние', icon: <Clock size={14} />,
        emojis: [],
    },
    {
        id: 'people', label: 'Смайлы', icon: <Smile size={14} />,
        emojis: ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🤧','😇','🥳','🥺','🤠','🤡','🤥','🤫','🤭','🧐','🤓','👋','🤚','🖐️','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦵','🦶','👂','👃','🧠','👀','👁️','👅','👄','💋','🫀','🫁'],
    },
    {
        id: 'nature', label: 'Животные', icon: <Dog size={14} />,
        emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🦂','🐢','🦎','🐍','🦕','🦖','🦕','🦎','🐸','🦈','🐙','🦑','🦞','🦀','🐡','🐟','🐬','🐳','🐋','🦭','🌸','🌺','🌹','🌷','🌻','🌼','🌿','🍀','🌱','🌲','🌳','🌴','🌵','🎋','🎍','☘️','🍁','🍂','🍃','🐾','🌍','🌎','🌏','🌐','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘','🌙','🌚','🌛','🌜','🌝','🌞','⭐','🌟','💫','✨','⚡','🌤️','⛅','🌥️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌀','🌈','🌂','☂️','☔','⛱️','⚡','❄️','🔥','💧','🌊'],
    },
    {
        id: 'food', label: 'Еда', icon: <Utensils size={14} />,
        emojis: ['🍕','🍔','🍟','🌭','🍿','🧂','🥓','🥚','🍳','🧇','🥞','🧈','🍞','🥐','🥖','🫓','🥨','🥯','🧀','🥗','🥙','🥪','🌮','🌯','🫔','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🫒','🥑','🍆','🥔','🥕','🌽','🌶️','🫑','🥒','🥬','🥦','🧄','🧅','🍄','☕','🍵','🧃','🥤','🧋','🍶','🍾','🍷','🍸','🍹','🍺','🥂','🥃','🧊'],
    },
    {
        id: 'travel', label: 'Поездки', icon: <Plane size={14} />,
        emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🚨','🚥','🚦','🛑','🚧','🏗️','🚀','🛸','✈️','🛩️','🛫','🛬','🛳️','🚢','⛴️','🛥️','🚤','⛵','🚁','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🗺️','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🏗️','🧱','🏘️','🏚️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','🕋','⛩️','🗾','🎑','🏞️','🌅','🌄','🌠','🎇','🎆','🌃','🏙️','🌉','🌌'],
    },
    {
        id: 'activity', label: 'Активности', icon: <Trophy size={14} />,
        emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🥍','🏑','🏏','🥊','🥋','🎽','⛸️','🛷','🎿','🏂','🪂','🏋️','🤸','⛹️','🤺','🏊','🏄','🚣','🧘','🧗','🚵','🚴','🏇','🤼','🤾','🏌️','🏹','🎣','🤿','🎯','🎽','🎪','🎭','🎨','🖼️','🎰','🚂','🎫','🎟️','🎗️','🎀','🎁','🎊','🎉','🎋','🎍','🎎','🎏','🎐','🧧','🎑','🎃','🎄','🎆','🎇','🧨','✨','🎈','🎌','🏮','🎍','🎎','🎏','🧸','🪆','🎭','🎬','🎤','🎧','🎷','🎸','🎹','🎺','🎻','🪘','🥁','📻','🎙️','📺','📷','📸','📹','🎥','📽️','🎞️','📞'],
    },
    {
        id: 'objects', label: 'Объекты', icon: <Hash size={14} />,
        emojis: ['💡','🔦','🕯️','🪔','💰','💴','💵','💶','💷','💸','💳','🪙','💹','📈','📉','📊','✉️','📧','📨','📩','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','📊','📋','📁','📂','🗂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','🛡️','🔧','🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🧰','🧲','💊','💉','🩸','🩹','🩺','🌡️','🧪','🧫','🧬','🔬','🔭','📡','🛰️','🚀','🧯','🛒','🚿','🛁','🪣','🧼','🪒','🧴','🧷','🧹','🧺','🧻','🪣','🏠','📱','💻','🖥️','🖨️','⌨️','🖱️','💽','💾','💿','📀','📱','☎️','📟','📠','🔋','🔌','💡','🔦','🕯️'],
    },
]

function getRecent(): string[] {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    } catch { return [] }
}

function saveRecent(emoji: string) {
    const prev = getRecent().filter(e => e !== emoji)
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...prev].slice(0, MAX_RECENT)))
}

interface EmojiPickerProps {
    onSelect: (emoji: string) => void
    onClose: () => void
}

export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
    const [activeCat, setActiveCat] = useState('people')
    const [recent, setRecent] = useState<string[]>([])
    const [search, setSearch] = useState('')
    const ref = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const r = getRecent()
        setRecent(r)
        if (r.length > 0) setActiveCat('recent')
        setTimeout(() => searchRef.current?.focus(), 50)
    }, [])

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('mousedown', handler)
        document.addEventListener('keydown', keyHandler)
        return () => {
            document.removeEventListener('mousedown', handler)
            document.removeEventListener('keydown', keyHandler)
        }
    }, [onClose])

    const handleSelect = (emoji: string) => {
        saveRecent(emoji)
        setRecent(getRecent())
        onSelect(emoji)
    }

    const searchLower = search.toLowerCase()
    const searchResults = search.length > 0
        ? CATEGORIES.flatMap(c => c.emojis).filter(e => e.includes(search))
        : null

    const cats = CATEGORIES.map(c => c.id === 'recent' ? { ...c, emojis: recent } : c)
    const activeCatData = cats.find(c => c.id === activeCat)
    const displayEmojis = searchResults ?? activeCatData?.emojis ?? []

    return (
        <div
            ref={ref}
            className="absolute bottom-full left-0 mb-2 z-50 bg-white rounded-2xl border border-[#E4ECFC] shadow-lg flex flex-col overflow-hidden"
            style={{ width: 320, maxHeight: 380 }}
        >
            {/* Search bar */}
            <div className="px-3 pt-3 pb-2">
                <input
                    ref={searchRef}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Поиск эмодзи..."
                    className="w-full h-8 px-3 rounded-lg bg-[#F1F5FD] text-[13px] outline-none placeholder-[#94A3B8] text-[#0F172A]"
                />
            </div>

            {/* Category tabs */}
            {!search && (
                <div className="flex items-center gap-0.5 px-2 pb-1.5 border-b border-[#E4ECFC] overflow-x-auto no-scrollbar">
                    {cats.map(cat => (
                        (cat.id === 'recent' && recent.length === 0) ? null : (
                            <button
                                key={cat.id}
                                onClick={() => setActiveCat(cat.id)}
                                title={cat.label}
                                className={`flex-shrink-0 w-8 h-7 flex items-center justify-center rounded-lg transition-colors ${
                                    activeCat === cat.id
                                        ? 'bg-[#2AABEE]/15 text-[#2AABEE]'
                                        : 'text-[#64748B] hover:bg-[#F1F5FD]'
                                }`}
                            >
                                {cat.icon}
                            </button>
                        )
                    ))}
                </div>
            )}

            {/* Emoji grid */}
            <div className="flex-1 overflow-y-auto p-2">
                {displayEmojis.length === 0 ? (
                    <div className="text-center text-[13px] text-[#94A3B8] py-6">
                        {search ? 'Ничего не найдено' : 'Пока пусто'}
                    </div>
                ) : (
                    <div className="grid gap-0.5" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
                        {displayEmojis.map((emoji, i) => (
                            <button
                                key={`${emoji}-${i}`}
                                onClick={() => handleSelect(emoji)}
                                className="w-9 h-9 flex items-center justify-center text-xl rounded-lg hover:bg-[#F1F5FD] transition-colors select-none"
                                title={emoji}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
