'use client';
export default function ErrorPage({reset}) {
  return <main className="route-error" role="alert"><h1>画面を読み込めませんでした</h1><p>入力中の画面がある場合は、その画面を閉じずに接続を確認してください。</p><button type="button" onClick={reset}>もう一度読み込む / Try again</button><a href="/account">アカウントへ / Account</a></main>;
}
