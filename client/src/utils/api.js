/**
 * Normalize an API base URL from env or fallback.
 * @param {string} rawUrl
 * @returns {string}
 */
export const normalizeApiBase = (rawUrl) => {
  const value = (rawUrl || "").trim();
  if (!value) return "http://localhost:5000";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

/**
 * Parse an error message from a failed HTTP response.
 * @param {Response} response
 * @returns {Promise<string>}
 */
export const parseErrorMessage = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return data?.error || `Request failed (${response.status})`;
  }
  const text = await response.text();
  return text || `Request failed (${response.status})`;
};
