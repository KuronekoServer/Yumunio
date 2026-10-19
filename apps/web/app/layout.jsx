import '../src/app.css';

export const metadata = {
  title: { default: 'Yumunio', template: 'Yumunio — %s' },
  description: 'ページ、ノート、データベースをひとつのワークスペースに。',
  referrer: 'no-referrer',
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#FAFBFD' };

export default function RootLayout({children}) {
  return <html lang="ja" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
