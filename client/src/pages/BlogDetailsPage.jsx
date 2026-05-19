import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";

const API = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/+$/, "");

export default function BlogDetailsPage() {
  const { slug } = useParams();
  const [blog, setBlog] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/blogs/${slug}`);
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();
        setBlog(data.blog);
      } catch {
        setError("Blog not found.");
      }
    };
    load();
  }, [slug]);

  if (error) {
    return (
      <section className="panel">
        <p className="statusLine">{error}</p>
        <Link to="/blogs" className="textLink">Back to blogs</Link>
      </section>
    );
  }

  if (!blog) return <section className="panel"><p className="statusLine">Loading article...</p></section>;

  return (
    <section className="panel">
      <h1>{blog.title}</h1>
      <p className="lead">{blog.excerpt}</p>
      <div className="metaLine">
        <span>{blog.category}</span>
        <span>{new Date(blog.publishedAt).toLocaleString()}</span>
      </div>
      <div className="articleBody">
        {blog.content.map((line, i) => <p key={`${blog.slug}-${i}`}>{line}</p>)}
      </div>
      <a href={blog.sourceUrl} target="_blank" rel="noreferrer" className="textLink">Read original source</a>
    </section>
  );
}
