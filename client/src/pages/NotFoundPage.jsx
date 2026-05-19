import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <section className="panel">
      <h1>404</h1>
      <p className="lead">The page you requested does not exist.</p>
      <Link to="/" className="textLink">Back to home</Link>
    </section>
  );
}
