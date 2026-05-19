import { useEffect } from "react";

const faqItems = [
  {
    q: "How can I download TikTok videos without login?",
    a: "Open the TikTok tab, paste your TikTok link, and start the download. Downvid offers fast TikTok video downloading without account signup."
  },
  {
    q: "Can I download Instagram videos and reels for free?",
    a: "Yes. Use the Instagram route to download Instagram videos, reels, and clips in a few seconds with a free no-login workflow."
  },
  {
    q: "Does this tool support Pinterest video download?",
    a: "Yes. You can download Pinterest videos and supported Pinterest media by selecting Pinterest first, then pasting the exact URL."
  },
  {
    q: "Can I download YouTube videos with this downloader?",
    a: "Yes. Downvid supports downloading YouTube videos through the dedicated YouTube page route and matching URL validation."
  },
  {
    q: "Is Downvid free and secure to use?",
    a: "Downvid is free to use with no login required. The app validates platform URLs and provides a direct, clean download flow."
  }
];

export default function FaqPage() {
  useEffect(() => {
    document.title = "FAQs | Download TikTok, Instagram, Pinterest, YouTube Videos";
    const descriptionMeta = document.querySelector('meta[name="description"]');
    if (descriptionMeta) {
      descriptionMeta.setAttribute(
        "content",
        "FAQs about how to download TikTok videos, download Instagram videos, download Pinterest videos, and download YouTube videos with Downvid."
      );
    }
  }, []);

  return (
    <section className="panel">
      <h1>Frequently Asked Questions</h1>
      <p className="lead">
        Answers about video downloading, music downloading, supported platforms, and best practices for fast downloads.
      </p>
      <div className="faqGrid">
        {faqItems.map((item) => (
          <details key={item.q} className="faqItem">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
