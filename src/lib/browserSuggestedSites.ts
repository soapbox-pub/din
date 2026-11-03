/**
 * Sites the address bar suggests before they're in history, so on a fresh
 * install "goo" completes to google.com and "redd" to reddit.com. Most
 * popular first: between suggested sites that match equally, the earlier
 * one wins, and past the limit (see `withSuggestedSites`) the later ones
 * drop out first.
 *
 * Each URL is where the site's front page settles, so picking one doesn't
 * go through a redirect, and its host (less `www.`) starts with the name
 * people type (www.spotify.com, not open.spotify.com).
 */
export const SUGGESTED_SITES: { url: string; title: string }[] = [
  { url: 'https://www.google.com/', title: 'Google' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://www.facebook.com/', title: 'Facebook' },
  { url: 'https://www.wikipedia.org/', title: 'Wikipedia' },
  { url: 'https://www.instagram.com/', title: 'Instagram' },
  { url: 'https://www.reddit.com/', title: 'Reddit' },
  { url: 'https://x.com/', title: 'X' },
  { url: 'https://www.amazon.com/', title: 'Amazon' },
  { url: 'https://chatgpt.com/', title: 'ChatGPT' },
  { url: 'https://www.whatsapp.com/', title: 'WhatsApp' },
  { url: 'https://www.tiktok.com/', title: 'TikTok' },
  { url: 'https://www.bing.com/', title: 'Bing' },
  { url: 'https://www.yahoo.com/', title: 'Yahoo' },
  { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
  { url: 'https://www.linkedin.com/', title: 'LinkedIn' },
  { url: 'https://www.netflix.com/', title: 'Netflix' },
  { url: 'https://gmail.com/', title: 'Gmail' },
  { url: 'https://outlook.com/', title: 'Outlook' },
  { url: 'https://github.com/', title: 'GitHub' },
  { url: 'https://www.twitch.tv/', title: 'Twitch' },
  { url: 'https://discord.com/', title: 'Discord' },
  { url: 'https://www.pinterest.com/', title: 'Pinterest' },
  { url: 'https://www.ebay.com/', title: 'eBay' },
  { url: 'https://claude.ai/', title: 'Claude' },
  { url: 'https://www.spotify.com/', title: 'Spotify' },
  { url: 'https://www.microsoft.com/', title: 'Microsoft' },
  { url: 'https://www.apple.com/', title: 'Apple' },
  { url: 'https://www.imdb.com/', title: 'IMDb' },
  { url: 'https://www.paypal.com/', title: 'PayPal' },
  { url: 'https://stackoverflow.com/', title: 'Stack Overflow' },
  { url: 'https://www.quora.com/', title: 'Quora' },
  { url: 'https://www.bbc.com/', title: 'BBC' },
  { url: 'https://www.cnn.com/', title: 'CNN' },
  { url: 'https://www.nytimes.com/', title: 'The New York Times' },
  { url: 'https://www.espn.com/', title: 'ESPN' },
  { url: 'https://weather.com/', title: 'The Weather Channel' },
  { url: 'https://www.walmart.com/', title: 'Walmart' },
  { url: 'https://www.etsy.com/', title: 'Etsy' },
  { url: 'https://www.craigslist.org/', title: 'Craigslist' },
  { url: 'https://zoom.us/', title: 'Zoom' },
  { url: 'https://www.dropbox.com/', title: 'Dropbox' },
  { url: 'https://medium.com/', title: 'Medium' },
  { url: 'https://archive.org/', title: 'Internet Archive' },
  { url: 'https://proton.me/', title: 'Proton' },
  // The new-tab page's own sites.
  { url: 'https://ditto.pub/', title: 'Ditto' },
  { url: 'https://soapbox.pub/', title: 'Soapbox' },
  { url: 'https://shakespeare.diy/', title: 'Shakespeare' },
  { url: 'https://nostrhub.io/', title: 'NostrHub' },
  { url: 'https://armada.buzz/', title: 'Armada' },
  { url: 'https://agora.spot/', title: 'Agora' },
];
