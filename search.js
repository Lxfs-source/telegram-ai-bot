async function webSearch(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults
    })
  });

  const data = await res.json();

  return (data.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content
  }));
}

module.exports = { webSearch };