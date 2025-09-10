// utils/jobFetcher.js
const fetch = require ("node-fetch");

async function fetchJobs(jobTitle, skills = []) {
  try {
    const query = encodeURIComponent([jobTitle, ...skills].join(" "));
    
    // ✅ Correct Remotive API endpoint
    const url = `https://remotive.com/api/remote-jobs?search=${query}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.status}`);
    }

    const data = await response.json();

    // Map jobs into simplified structure
    return data.jobs.slice(0, 10).map(job => ({
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location || "Remote",
      url: job.url,
      platform: "Remotive"
    }));
  } catch (error) {
    console.error("Job fetch error:", error);
    return [];
  }
}
module.exports = fetchJobs;