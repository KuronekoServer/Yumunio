const paths={
 page:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
 notebook:'M6 3h11a2 2 0 0 1 2 2v15H6z M3 7h6 M3 12h6 M3 17h6 M12 8l5-5 3 3-5 5h-3z',
 plus:'M12 5v14 M5 12h14',menu:'M4 6h16 M4 12h16 M4 18h16',
 undo:'M4 8h9a7 7 0 0 1 0 14 M4 8l5-5 M4 8l5 5',redo:'M20 8h-9a7 7 0 0 0 0 14 M20 8l-5-5 M20 8l-5 5',
 close:'M6 6l12 12 M18 6L6 18',refresh:'M20 7v5h-5 M19 12a7 7 0 1 1-2-6',
 search:'M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
 inbox:'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5',home:'M3 11l9-8 9 8 M5 10v11h14V10 M9 21v-7h6v7',
 settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',more:'M5 12h.01 M12 12h.01 M19 12h.01',
 trash:'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
 download:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',arrow:'M5 12h14 M13 6l6 6-6 6',
 chevron:'M9 5l7 7-7 7',star:'M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
 template:'M3 3h18v18H3z M3 9h18 M9 9v12',table:'M3 4h18v16H3z M3 10h18 M9 4v16',
 users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
 sidebar:'M3 4h18v16H3z M9 4v16',
};
export function Icon({name='page',...props}){return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]||paths.page}/></svg>;}
