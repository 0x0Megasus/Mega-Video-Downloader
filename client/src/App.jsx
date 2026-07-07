import { NavLink, Route, Routes } from "react-router-dom";
import { Home, Newspaper, HelpCircle } from "lucide-react";
import HomePage from "./pages/HomePage";
import BlogsPage from "./pages/BlogsPage";
import BlogDetailsPage from "./pages/BlogDetailsPage";
import NotFoundPage from "./pages/NotFoundPage";
import FaqPage from "./pages/FaqPage";
import { Link } from "react-router-dom";

const platformRoutes = ["youtube", "tiktok", "instagram", "facebook", "pinterest", "x", "reddit"];

export default function App() {
  return (
    <div className="appShell">
      <header className="topbar">
        <Link to="/" className="brand">
          Down<span className="brandAccent">vid</span>
        </Link>
        <nav className="mainNav">
          <NavLink to="/" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <Home size={15} /> Home
          </NavLink>
          <NavLink to="/blogs" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <Newspaper size={15} /> Blogs
          </NavLink>
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
          <Route path="/blogs" element={<BlogsPage />} />
          <Route path="/blogs/:slug" element={<BlogDetailsPage />} />
          <Route path="/faqs" element={<FaqPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
