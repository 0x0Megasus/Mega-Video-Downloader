import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { Home, HelpCircle } from "lucide-react";
import HomePage from "./pages/HomePage";
import NotFoundPage from "./pages/NotFoundPage";
import FaqPage from "./pages/FaqPage";

const platformRoutes = ["youtube", "tiktok", "instagram", "facebook", "pinterest", "x", "reddit"];

export default function App() {
  const location = useLocation();
  const isHome = location.pathname === "/" || location.pathname.startsWith("/platform/") || location.pathname === "/music-downloader";

  return (
    <div className="appShell">
      <header className="topbar">
        <Link to="/" className="brand">
          Down<span className="brandAccent">vid</span>
        </Link>
        <nav className="mainNav">
          <Link to="/" className={`navLink ${isHome ? "active" : ""}`}>
            <Home size={15} /> Home
          </Link>
          <NavLink to="/faqs" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <HelpCircle size={15} /> FAQs
          </NavLink>
        </nav>
      </header>

      <main className="mainWrap">
        <Routes>
          <Route path="/" element={<HomePage />} />
          {platformRoutes.map((platform) => (
            <Route key={platform} path={`/platform/${platform}`} element={<HomePage platformKey={platform} />} />
          ))}
          <Route path="/music-downloader" element={<HomePage forceMode="music" />} />
          <Route path="/faqs" element={<FaqPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
