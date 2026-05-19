import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

const API = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/+$/, "");

export default function BlogsPage() {
  const [blogs, setBlogs] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/blogs`);
        const data = await res.json();
        setBlogs(data.blogs || []);
      } catch {
        setError("Failed to load blogs.");
      }
    };
    load();
  }, []);

  return (
    <section className="panel">
      <h1>Tech, AI and IT News</h1>
      <p className="lead">Fresh auto-generated summaries are refreshed every hour from trusted public APIs.</p>
      {error && <p className="statusLine">{error}</p>}
      <div className="blogGrid">
        {blogs.map((blog) => (
          <article key={blog.slug} className="blogCard">
            <h3>{blog.title}</h3>
            <p>{blog.excerpt}</p>
            <div className="metaLine">
              <span>{blog.category}</span>
              <span>{new Date(blog.publishedAt).toLocaleString()}</span>
            </div>
            <Link to={`/blogs/${blog.slug}`} className="textLink">Read article</Link>
          </article>
        ))}
      </div>
    </section>
  );
}
