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
  },
  {
    q: "How do I download music from YouTube?",
    a: "Go to the Home tab, enter a song or artist name, click 'Find songs' to search YouTube, then select the track you want and click 'Download' to save the music file."
  },
  {
    q: "What audio format does the music downloader support?",
    a: "Downvid downloads music in MP3 format by default, which is compatible with all devices and media players."
  },
  {
    q: "Can I download an entire playlist or album?",
    a: "You can search for and download individual songs through the music downloader. Search for specific tracks by song title or artist name."
  },
  {
    q: "How long does music download take?",
    a: "Music downloads typically complete within seconds to a minute depending on your internet speed and the file size."
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
