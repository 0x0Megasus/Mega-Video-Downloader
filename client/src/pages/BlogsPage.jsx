import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";

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
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [mode, setMode] = useState("latest");
  const sentinelRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const res = await fetch(`${API}/api/blogs?page=1&limit=12&mode=${mode}`);
        if (!res.ok) {
          throw new Error(await parseApiError(res));
        }
        const data = await res.json();
        setBlogs(data.blogs || []);
        setHasMore(Boolean(data.hasMore));
        setPage(1);
        setError("");
      } catch (err) {
        setError(err?.message || "Failed to load blogs.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [mode]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      async (entries) => {
        const first = entries[0];
        if (!first?.isIntersecting || loading || !hasMore) return;

        try {
          setLoading(true);
          const nextPage = page + 1;
          const res = await fetch(`${API}/api/blogs?page=${nextPage}&limit=12&mode=${mode}`);
          if (!res.ok) throw new Error(await parseApiError(res));
          const data = await res.json();
          setBlogs((prev) => [...prev, ...(data.blogs || [])]);
          setHasMore(Boolean(data.hasMore));
          setPage(nextPage);
        } catch (err) {
          setError(err?.message || "Failed to load more blogs.");
        } finally {
          setLoading(false);
        }
      },
      { rootMargin: "300px" }
    );

    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, mode, page]);

  return (
    <section className="panel">
      <h1>Tech, AI and IT News</h1>
      <p className="lead">Fresh auto-generated summaries are refreshed every hour from trusted public APIs.</p>
      <div className="modeTabs blogTabs">
        <button className={mode === "latest" ? "active" : ""} type="button" onClick={() => setMode("latest")}>Latest</button>
        <button className={mode === "interesting" ? "active" : ""} type="button" onClick={() => setMode("interesting")}>Most Interesting</button>
      </div>
      {error && <p className="statusLine warning">{error}</p>}
      <div className="blogGrid">
        {blogs.map((blog) => (
          <article key={blog.slug} className="blogCard">
            <div className="blogThumb">
              {blog.imageUrl ? <img src={blog.imageUrl} alt={blog.title} loading="lazy" /> : <div className="blogThumbFallback">NEWS</div>}
            </div>
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
      <div ref={sentinelRef} />
      {loading && <p className="statusLine">Loading more blogs...</p>}
      {!hasMore && blogs.length > 0 && <p className="statusLine">No more blogs for now.</p>}
    </section>
  );
}
