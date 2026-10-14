// Icone identiche a quelle della versione HTML standalone (stile lucide, inline)
function Icon({ children, size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}
export const Plus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>;
export const X = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12"/></Icon>;
export const TrendingUp = (p) => <Icon {...p}><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></Icon>;
export const TrendingDown = (p) => <Icon {...p}><path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/></Icon>;
export const ArrowUpRight = (p) => <Icon {...p}><path d="M7 17 17 7"/><path d="M7 7h10v10"/></Icon>;
export const ArrowDownRight = (p) => <Icon {...p}><path d="M7 7l10 10"/><path d="M17 7v10H7"/></Icon>;
export const Wallet = (p) => <Icon {...p}><path d="M20 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/><path d="M3 7V5a2 2 0 0 1 2-2h13v4"/><circle cx="17" cy="14" r="1.5"/></Icon>;
export const PiggyBank = (p) => <Icon {...p}><path d="M11 3c-3.5 0-6 2.5-6 5.5 0 1 .3 2 .8 2.8L4 14v2h2l1 2h3l1-2h2l1 2h1l1-3c1.7-.5 3-2.1 3-4 0-3-2.9-6-8-6Z"/><circle cx="9" cy="9" r=".7" fill="currentColor" stroke="none"/><path d="M17 9h2"/></Icon>;
export const Trash2 = (p) => <Icon {...p}><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></Icon>;
export const LayoutDashboard = (p) => <Icon {...p}><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="14" width="8" height="7" rx="1"/></Icon>;
export const Receipt = (p) => <Icon {...p}><path d="M5 3h14v18l-2-1.5L15 21l-2-1.5L11 21l-2-1.5L7 21l-2-1.5Z"/><path d="M8 8h8M8 12h8M8 16h5"/></Icon>;
export const LineChartIcon = (p) => <Icon {...p}><path d="M3 3v18h18"/><path d="M6 15l4-5 3 3 5-7"/></Icon>;
export const Landmark = (p) => <Icon {...p}><path d="M3 21h18"/><path d="M4 10h16"/><path d="M12 2 3 8h18Z"/><path d="M6 10v8M10 10v8M14 10v8M18 10v8"/></Icon>;
export const Pencil = (p) => <Icon {...p}><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5l4 4"/></Icon>;
export const ArrowUp = (p) => <Icon {...p}><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></Icon>;
export const ArrowDown = (p) => <Icon {...p}><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></Icon>;
export const Tag = (p) => <Icon {...p}><path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.29-8.29a1 1 0 0 0 0-1.41Z"/><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none"/></Icon>;
export const CheckCircle2 = (p) => <Icon {...p}><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="m9 12 2 2 4-4"/></Icon>;
export const Target = (p) => <Icon {...p}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></Icon>;



export const Menu = (p) => <Icon {...p}><path d="M4 6h16M4 12h16M4 18h16"/></Icon>;
export const Upload = (p) => <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></Icon>;
export const FileText = (p) => <Icon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></Icon>;
export const Sparkles = (p) => <Icon {...p}><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></Icon>;
export const Send = (p) => <Icon {...p}><path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4Z"/></Icon>;
export const ArrowRightLeft = (p) => <Icon {...p}><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></Icon>;
export const Settings = (p) => <Icon {...p}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></Icon>;
export const Filter = (p) => <Icon {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></Icon>;
