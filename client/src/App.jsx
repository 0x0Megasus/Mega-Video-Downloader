import { NavLink, Route, Routes } from "react-router-dom";
import { FaNewspaper } from "react-icons/fa6";
import { IoHomeSharp } from "react-icons/io5";
import { RiQuestionAnswerFill } from "react-icons/ri";
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
        <Link to="/" className="brand">Downvid</Link>
        <nav className="mainNav">
          <NavLink to="/" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <IoHomeSharp /> Home
          </NavLink>
          <NavLink to="/blogs" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <FaNewspaper /> Blogs
          </NavLink>
          <NavLink to="/faqs" className={({ isActive }) => `navLink ${isActive ? "active" : ""}`}>
            <RiQuestionAnswerFill /> FAQs
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
