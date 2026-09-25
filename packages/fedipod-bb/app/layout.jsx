import './globals.css';
import { Agentation } from 'agentation';

export const metadata = { title: 'FediPod-BB', icons: { icon: '/forum.svg' } };

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}{process.env.NODE_ENV === 'development' && <Agentation />}</body></html>;
}
