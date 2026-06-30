import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Particle Portrait",
  description: "GPU particle portrait — react-three-fiber + custom GLSL",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
