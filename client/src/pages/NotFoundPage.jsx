import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function NotFoundPage() {
  return (
    <section className="panel notFound">
      <h2>404</h2>
      <p>The page you requested does not exist.</p>
      <Link to="/" className="primaryBtn" style={{ display: "inline-flex", textDecoration: "none" }}>
        <ArrowLeft size={14} /> Back to home
      </Link>
    </section>
  );
}
