import { Link, useNavigate, useParams } from "react-router-dom";
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

export default function BlogDetailsPage() {
  const navigate = useNavigate();
  const { slug } = useParams();
  const [blog, setBlog] = useState(null);
  const [error, setError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/blogs/${slug}`);
        if (!res.ok) throw new Error(await parseApiError(res));
        const data = await res.json();
        setBlog(data.blog);
      } catch (err) {
        setError(err?.message || "Blog not found.");
      }
    };
    load();
  }, [slug]);

  if (error) {
    return (
      <section className="panel">
        <p className="statusLine warning">{error}</p>
        <Link to="/blogs" className="textLink">Back to blogs</Link>
      </section>
    );
  }

  if (!blog) return <section className="panel"><p className="statusLine">Loading article...</p></section>;

  return (
    <section className="panel">
      <button type="button" className="backBtn" onClick={() => navigate(-1)}>Go back</button>
      <h1>{blog.title}</h1>
      <p className="lead">{blog.excerpt}</p>
      {blog.imageUrl && !imageFailed && (
        <img
          className="detailImage"
          src={blog.imageUrl.replace(/^http:\/\//i, "https://")}
          alt={blog.title}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="metaLine">
        <span className="categoryBadge">{blog.category}</span>
        <span>{new Date(blog.publishedAt).toLocaleString()}</span>
      </div>
      <div className="articleBody">
        {blog.content.map((line, i) => <p key={`${blog.slug}-${i}`}>{line}</p>)}
      </div>
      <a href={blog.sourceUrl} target="_blank" rel="noreferrer" className="textLink">Read original source</a>
    </section>
  );
}
