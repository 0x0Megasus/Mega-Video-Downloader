import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

const normalizeApiBase = (rawUrl) => {
  const value = (rawUrl || "").trim();
  if (!value) return "http://localhost:5000";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

const API = normalizeApiBase(import.meta.env.VITE_API_URL);

const parseApiError = async (res) => {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    return data?.error || `Request failed (${res.status})`;
  }
  const text = await res.text();
  return text || `Request failed (${res.status})`;
};

export default function BlogsPage() {
  const [blogs, setBlogs] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/blogs`);
        if (!res.ok) {
          throw new Error(await parseApiError(res));
        }
        const data = await res.json();
        setBlogs(data.blogs || []);
      } catch (err) {
        setError(err?.message || "Failed to load blogs.");
      }
    };
    load();
  }, []);

  return (
    <section className="panel">
      <h1>Tech, AI and IT News</h1>
      <p className="lead">Fresh auto-generated summaries are refreshed every hour from trusted public APIs.</p>
      {error && <p className="statusLine warning">{error}</p>}
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
