// Shared Instagram Graph API helpers

const API_BASE = "https://graph.instagram.com/v22.0";

// Insights metric values come back in two envelope shapes depending on metric:
//   - time-series:   { values: [{ value: N, end_time: ... }] }   (most metrics, including reels_skip_rate)
//   - total-value:   { total_value: { value: N } }               (newer metrics, e.g. profile_views with metric_type=total_value)
// Try both so we don't crash if Meta moves a metric between shapes.
function extractMetricValue(item) {
  if (item.total_value !== undefined) return item.total_value?.value ?? null;
  return item.values?.[0]?.value ?? null;
}

// `token` may be a string or a getter function. Pass a getter (see lib/token.js)
// so a token refreshed mid-process takes effect on the next call instead of
// staying pinned to whatever was read at startup.
export function createClient(token) {
  const getToken = typeof token === "function" ? token : () => token;

  async function api(path, params = {}) {
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set("access_token", getToken());
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      throw new Error(`IG API error: ${data.error.message}`);
    }
    return data;
  }

  return {
    // Get user profile
    async getProfile() {
      return api("/me", { fields: "id,username,followers_count,media_count" });
    },

    // Get all media (handles pagination)
    async getAllMedia() {
      const fields =
        "id,caption,timestamp,media_type,like_count,comments_count,permalink";
      let results = [];
      let url = `${API_BASE}/me/media?fields=${fields}&limit=50&access_token=${getToken()}`;

      while (url) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(`IG API error: ${data.error.message}`);
        results.push(...(data.data || []));
        url = data.paging?.next || null;
      }
      return results;
    },

    // Get insights for a media item
    async getMediaInsights(mediaId, mediaType = null) {
      // Base metrics work for all media types (views became universal in v22.0)
      const baseMetrics = "reach,likes,comments,shares,saved,total_interactions,views";
      // Reel-specific metrics (VIDEO type only) — fetched separately since
      // mixing unsupported metrics causes the entire request to fail
      // Note: `reposts` was attempted but is not supported on the Instagram
      // Insights Media API for IGAA tokens (confirmed 2026-05-01 via direct
      // API call: "endpoint does not support the metrics: reposts"). Same
      // story as per-Reel `follows` — surfaced in IG's mobile insights UI
      // but not exposed to the Graph API. Dashboard drops "Repost Rate".
      const reelMetrics = "ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate";
      try {
        const data = await api(`/${mediaId}/insights`, { metric: baseMetrics });
        const result = {};
        for (const item of data.data || []) {
          result[item.name] = extractMetricValue(item);
        }
        // Fetch reel-specific metrics in a separate request
        if (mediaType === "VIDEO") {
          try {
            const reelData = await api(`/${mediaId}/insights`, { metric: reelMetrics });
            for (const item of reelData.data || []) {
              result[item.name] = extractMetricValue(item);
            }
          } catch (e) {
            // Log but continue — base metrics already captured. Without this log,
            // a real API failure is indistinguishable from Meta legitimately
            // withholding skip_rate on low-reach Reels.
            console.error(`  Failed to get reel metrics for ${mediaId}: ${e.message}`);
          }
        }
        return result;
      } catch (e) {
        console.error(`  Failed to get insights for ${mediaId}: ${e.message}`);
        return null;
      }
    },

    // Get account-level insights (follower count, profile views)
    async getAccountInsights() {
      try {
        const profile = await api("/me", { fields: "id,username,followers_count,media_count" });
        // Profile views requires insights API with period
        let profileViews = 0;
        try {
          const data = await api("/me/insights", {
            metric: "profile_views",
            period: "day",
            metric_type: "total_value",
          });
          for (const item of data.data || []) {
            if (item.name === "profile_views") {
              profileViews = item.total_value?.value ?? 0;
            }
          }
        } catch {}
        return {
          followers_count: profile.followers_count || 0,
          media_count: profile.media_count || 0,
          profile_views: profileViews,
        };
      } catch (e) {
        console.error(`  Failed to get account insights: ${e.message}`);
        return null;
      }
    },

    // Get comments on a media item (handles pagination)
    async getComments(mediaId) {
      const fields = "id,text,username,timestamp";
      let results = [];
      let url = `${API_BASE}/${mediaId}/comments?fields=${fields}&limit=50&access_token=${getToken()}`;

      while (url) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(`IG API error: ${data.error.message}`);
        results.push(...(data.data || []));
        url = data.paging?.next || null;
      }
      return results;
    },

    // Send a private reply to a comment (DM triggered by a comment)
    async sendPrivateReply(commentId, messageText) {
      const url = `${API_BASE}/me/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text: messageText },
          access_token: getToken(),
        }),
      });
      const data = await res.json();
      if (data.error) {
        const err = new Error(`IG Messaging error: ${data.error.message}`);
        err.igError = data.error; // attach raw error object for failure classification
        throw err;
      }
      return data;
    },

    // Post a public reply to a comment
    async replyToComment(commentId, messageText) {
      const url = `${API_BASE}/${commentId}/replies`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messageText, access_token: getToken() }),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(`IG Reply error: ${data.error.message}`);
      }
      return data;
    },

  };
}
