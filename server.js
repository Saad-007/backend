const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer");
require("dotenv").config();
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { readFileSync, existsSync, mkdirSync, unlinkSync } = require("fs");
const docxParser = require("docx-parser");
const { createWorker } = require("tesseract.js");
const pdftotext = require("pdftotextjs");
const htmlToDocx = require('html-to-docx');
const app = express();

// Configuration
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = "uploads";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain"
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only PDF, DOCX, and TXT files are allowed."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// Validate environment variables
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is missing in environment variables");
  process.exit(1);
}

const MODEL = "llama3-70b-8192";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Enhanced API call with better error handling
const callGroq = async (messages) => {
  try {
    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 3500,
        top_p: 1,
        response_format: { type: "json_object" }
      }),
      timeout: 30000 // 30 seconds timeout
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Groq API error ${resp.status}: ${errorText}`);
    }

    const data = await resp.json();
    
    if (!data.choices?.[0]?.message?.content) {
      throw new Error("Invalid response structure from Groq API");
    }

    return data;
  } catch (error) {
    console.error("Groq API call failed:", error);
    throw new Error(`Failed to call Groq API: ${error.message}`);
  }
};

const isPdfTextBased = async (filePath) => {
  try {
    const dataBuffer = readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer, { max: 1 }); // Check first page only
    return pdfData.text && pdfData.text.trim().length > 20;
  } catch (e) {
    return false;
  }
};

const processPdf = async (filePath) => {
  try {
    console.log("Trying pdf-parse...");
    const dataBuffer = readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer).catch(err => {
      console.log("pdf-parse failed:", err.message);
      return { text: "" };
    });

    if (pdfData.text && pdfData.text.trim().length > 50) {
      console.log("Extracted text with pdf-parse");
      return pdfData.text;
    }

    console.log("Trying pdftotextjs...");
    try {
      const pdf = new pdftotext(filePath);
      const text = await pdf.getText();
      if (text && text.trim().length > 50) {
        console.log("Extracted text with pdftotextjs");
        return text;
      }
    } catch (pdftotextError) {
      console.log("pdftotextjs failed:", pdftotextError.message);
    }

    console.log("Trying OCR with Tesseract...");
    const worker = await createWorker();
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    const { data: { text } } = await worker.recognize(filePath);
    await worker.terminate();

    if (text && text.trim().length > 50) {
      console.log("Extracted text with Tesseract OCR");
      return text;
    }

    throw new Error("PDF could not be processed by any method");
  } catch (error) {
    console.error("PDF processing error:", error.message);
    throw error;
  }
};

const processDocx = (filePath) => {
  return new Promise((resolve, reject) => {
    docxParser.parseDocx(filePath, (err, data) => {
      if (err) {
        reject(new Error(`DOCX processing failed: ${err.message}`));
      } else {
        resolve(data);
      }
    });
  });
};

const processTextFile = (filePath) => {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Text file processing failed: ${error.message}`);
  }
};

const validateFile = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ 
      success: false,
      error: "No file uploaded"
    });
  }

  if (req.file.mimetype === "application/pdf") {
    try {
      const isTextBased = await isPdfTextBased(req.file.path);
      if (!isTextBased) {
        console.warn("Image-based PDF detected, will try OCR fallback...");
      }
    } catch (err) {
      console.warn("PDF check failed:", err.message);
    }
  }
  
  next();
};

// Resume Feedback Endpoint// Resume Feedback Endpoint - IMPROVED VERSION
app.post("/api/resume/feedback", upload.single("resume"), validateFile, async (req, res, next) => {
  let filePath;
  
  try {
    filePath = req.file.path;
    let resumeText;

    // Process the uploaded file
    switch (req.file.mimetype) {
      case "application/pdf":
        resumeText = await processPdf(filePath);
        break;
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        resumeText = await processDocx(filePath);
        break;
      case "text/plain":
        resumeText = await processTextFile(filePath);
        break;
      default:
        throw new Error("Unsupported file type");
    }

    // Validate that we actually got resume text
    if (!resumeText || resumeText.trim().length < 50) {
      throw new Error("Resume text is too short or could not be extracted properly");
    }

    const messages = [{
      role: "system",
      content: `You are a professional resume analyst with 15+ years of experience in HR and recruitment. 
      Provide comprehensive feedback in this EXACT JSON format:
      {
        "overallScore": number (0-100),
        "categories": [ 
          {
            "name": string (e.g., "Formatting & Structure", "Content Quality", "Skills Presentation", "Achievements", "Customization"),
            "score": number (0-10),
            "feedback": string (detailed feedback with specific examples)
          }
        ],
        "strengths": string[] (list of 3-5 key strengths),
        "suggestions": string[] (list of 5-10 actionable suggestions),
        "jobTitleMatch": string (suggested job title based on content),
        "keywordAnalysis": [
          {
            "keyword": string,
            "count": number,
            "importance": "high" | "medium" | "low",
            "recommendation": string
          }
        ],
        "atsScore": number (0-100, compatibility with Applicant Tracking Systems)
      }
      
      IMPORTANT: 
      - Be specific and actionable in feedback
      - Provide concrete examples from the resume
      - Score realistically (average resumes should be 60-75)
      - Suggest improvements that can be implemented immediately
      - Focus on modern resume standards (2024)`
    }, {
      role: "user",
      content: `Please analyze this resume and provide comprehensive feedback:\n\n${resumeText.substring(0, 10000)}` // Limit to first 10k chars
    }];

    const groqResponse = await callGroq(messages);
    
    if (!groqResponse.choices?.[0]?.message?.content) {
      throw new Error("Invalid response structure from AI service");
    }

    let result;
    try {
      result = JSON.parse(groqResponse.choices[0].message.content);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      console.error("Raw response:", groqResponse.choices[0].message.content);
      throw new Error("Failed to parse AI response as JSON");
    }

    // Validate and sanitize the response
    const responseData = {
      overallScore: Math.min(Math.max(Number(result.overallScore) || 50, 0), 100),
      categories: Array.isArray(result.categories) 
        ? result.categories.map(cat => ({
            name: String(cat.name || "Uncategorized"),
            score: Math.min(Math.max(Number(cat.score) || 5, 0), 10),
            feedback: String(cat.feedback || "No specific feedback provided")
          }))
        : [
            {
              name: "General Assessment",
              score: 5,
              feedback: "Comprehensive analysis could not be generated. Please try again."
            }
          ],
      strengths: Array.isArray(result.strengths) 
        ? result.strengths.map(s => String(s)).filter(s => s.length > 0)
        : ["Strong foundational content", "Good structure"],
      suggestions: Array.isArray(result.suggestions)
        ? result.suggestions.map(s => String(s)).filter(s => s.length > 0)
        : ["Add more quantifiable achievements", "Include relevant keywords for your industry"],
      jobTitleMatch: String(result.jobTitleMatch || "Professional"),
      keywordAnalysis: Array.isArray(result.keywordAnalysis)
        ? result.keywordAnalysis.map(kw => ({
            keyword: String(kw.keyword || ""),
            count: Math.max(Number(kw.count) || 0, 0),
            importance: ["high", "medium", "low"].includes(kw.importance) ? kw.importance : "medium",
            recommendation: String(kw.recommendation || "Consider adding this keyword")
          })).filter(kw => kw.keyword)
        : [],
      atsScore: Math.min(Math.max(Number(result.atsScore) || 60, 0), 100)
    };

    // Ensure we have at least some data
    if (responseData.suggestions.length === 0) {
      responseData.suggestions = [
        "Use more action verbs (e.g., 'managed', 'developed', 'implemented')",
        "Quantify achievements with numbers and metrics",
        "Include relevant industry keywords",
        "Keep resume to 1-2 pages maximum",
        "Use consistent formatting throughout"
      ];
    }

    if (responseData.strengths.length === 0) {
      responseData.strengths = [
        "Clear section organization",
        "Relevant experience included",
        "Professional presentation"
      ];
    }

    return res.json({
      success: true,
      data: responseData,
      metadata: {
        processedLength: resumeText.length,
        analyzedDate: new Date().toISOString(),
        model: MODEL
      }
    });

  } catch (error) {
    console.error("Resume feedback error:", error);
    
    // Provide meaningful error response
    if (error.message.includes("timeout")) {
      return res.status(504).json({
        success: false,
        error: "Analysis timeout. Please try again with a shorter resume or check your internet connection."
      });
    }
    
    if (error.message.includes("JSON") || error.message.includes("parse")) {
      return res.status(500).json({
        success: false,
        error: "Failed to process analysis results. Please try again."
      });
    }

    if (error.message.includes("short") || error.message.includes("extract")) {
      return res.status(400).json({
        success: false,
        error: "Could not extract sufficient text from the resume. Please ensure the file is readable and try again."
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to analyze resume: " + error.message
    });
    
  } finally {
    // Clean up uploaded file
    if (filePath && existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch (cleanupError) {
        console.error("File cleanup error:", cleanupError);
      }
    }
  }
});
// Alternative PDF endpoint with custom template
app.post("/api/generate-analysis-pdf", async (req, res) => {
  try {
    const { analysisData, resumeData } = req.body;

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    
    const htmlTemplate = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .header { text-align: center; margin-bottom: 30px; }
          .score { font-size: 48px; color: #d97706; font-weight: bold; }
          .category { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
          .suggestion { margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Resume Analysis Report</h1>
          <div class="score">${analysisData.overallScore}/100</div>
          <p>Generated on ${new Date().toLocaleDateString()}</p>
        </div>
        
        <h2>Category Scores</h2>
        ${analysisData.categories.map(cat => `
          <div class="category">
            <h3>${cat.name} - ${cat.score}/10</h3>
            <p>${cat.feedback}</p>
          </div>
        `).join('')}
        
        <h2>Actionable Suggestions</h2>
        ${analysisData.suggestions.map(sug => `
          <div class="suggestion">• ${sug}</div>
        `).join('')}
      </body>
      </html>
    `;

    await page.setContent(htmlTemplate, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="resume_analysis_report.pdf"'
    });

    res.send(pdfBuffer);

  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});
// Generate DOCX Endpoint
// Generate DOCX Endpoint
const docx = require("docx");
const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, convertInchesToTwip } = docx;

// Generate DOCX Endpoint that matches website design
// Generate DOCX Endpoint using docx library
// Generate DOCX Endpoint that matches website structure
app.post("/api/generate-doc", async (req, res) => {
  try {
    const { resumeData } = req.body;
    console.log("Generating DOCX for resume data");

    if (!resumeData) {
      return res.status(400).json({ error: "No resume data provided" });
    }

    let finalFileName = "resume";
    if (resumeData.name) {
      finalFileName = resumeData.name
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
    }

    const children = [];
    const { name, contactInfo, summary, experience, education, skills, projects, certifications, languages } = resumeData;

    // Header section - matches website header
    if (name || contactInfo) {
      if (name) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: name,
                bold: true,
                size: 32,
                color: "2c3e50", // Dark blue-gray like website
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          })
        );
      }

      if (contactInfo) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: contactInfo,
                size: 22,
                color: "7f8c8d", // Gray like website
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
          })
        );
      }
    }

    // Education section - matches website education layout
    if (education && education.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "EDUCATION",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { after: 300 },
        })
      );

      education.forEach((edu, index) => {
        if (edu.institution || edu.degree) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: edu.institution || "",
                  bold: true,
                  size: 22,
                  color: "34495e",
                }),
                edu.institution && edu.degree ? new TextRun({ text: " • ", size: 22 }) : null,
                new TextRun({
                  text: edu.degree || "",
                  size: 22,
                  color: "34495e",
                }),
              ].filter(Boolean),
              spacing: { after: 100 },
            })
          );
        }

        if (edu.year) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: edu.year,
                  size: 20,
                  color: "95a5a6",
                  italics: true,
                }),
              ],
              spacing: { after: 200 },
            })
          );
        }

        if (index < education.length - 1) {
          children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
        }
      });
    }

    // Summary section - matches website summary
    if (summary) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "PROFESSIONAL SUMMARY",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 200 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: summary,
              size: 22,
            }),
          ],
          spacing: { after: 400 },
        })
      );
    }

    // Skills section - matches website skills layout
    if (skills && skills.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "TECHNICAL SKILLS",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 300 },
        })
      );

      // Skills as comma-separated list like website
      const skillsText = skills.join(' • ');
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: skillsText,
              size: 22,
            }),
          ],
          spacing: { after: 400 },
        })
      );
    }

    // Experience section - matches website experience layout
    if (experience && experience.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "PROFESSIONAL EXPERIENCE",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 300 },
        })
      );

      experience.forEach((exp, index) => {
        // Company and role
        if (exp.company || exp.role) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: exp.company || "",
                  bold: true,
                  size: 24,
                  color: "34495e",
                }),
                exp.company && exp.role ? new TextRun({ text: " - ", size: 24 }) : null,
                new TextRun({
                  text: exp.role || "",
                  italics: true,
                  size: 24,
                  color: "34495e",
                }),
              ].filter(Boolean),
              spacing: { after: 100 },
            })
          );
        }

        // Dates
        if (exp.startDate || exp.endDate) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${exp.startDate || ""} ${exp.startDate && exp.endDate ? " - " : ""} ${exp.endDate || "Present"}`,
                  size: 20,
                  color: "95a5a6",
                }),
              ],
              spacing: { after: 200 },
            })
          );
        }

        // Bullet points - matches website bullet style
        if (exp.bullets && exp.bullets.length > 0) {
          exp.bullets.forEach(bullet => {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: "• ",
                    bold: true,
                    size: 22,
                  }),
                  new TextRun({
                    text: bullet.replace(/^•\s*/, '').trim(),
                    size: 22,
                  }),
                ],
                indent: { left: 400 },
                spacing: { after: 100 },
              })
            );
          });
        }

        if (index < experience.length - 1) {
          children.push(new Paragraph({ text: "", spacing: { after: 300 } }));
        }
      });
    }

    // Projects section
    if (projects && projects.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "KEY PROJECTS",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 300 },
        })
      );

      projects.forEach((project, index) => {
        if (project.name) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: project.name,
                  bold: true,
                  size: 22,
                  color: "34495e",
                }),
              ],
              spacing: { after: 100 },
            })
          );
        }
        
        if (project.description) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: project.description,
                  size: 22,
                }),
              ],
              spacing: { after: 200 },
            })
          );
        }

        if (index < projects.length - 1) {
          children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
        }
      });
    }

    // Certifications section
    if (certifications && certifications.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "CERTIFICATIONS",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 300 },
        })
      );

      certifications.forEach((cert, index) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "• ",
                bold: true,
                size: 22,
              }),
              new TextRun({
                text: cert,
                size: 22,
              }),
            ],
            spacing: { after: 100 },
          })
        );
      });
    }

    // Languages section
    if (languages && languages.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "LANGUAGES",
              bold: true,
              size: 26,
              color: "2c3e50",
              underline: true,
            }),
          ],
          spacing: { before: 600, after: 300 },
        })
      );

      const languagesText = languages.join(' • ');
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: languagesText,
              size: 22,
            }),
          ],
          spacing: { after: 400 },
        })
      );
    }

    // Create the document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.5),
              right: convertInchesToTwip(0.5),
              bottom: convertInchesToTwip(0.5),
              left: convertInchesToTwip(0.5),
            }
          }
        },
        children: children,
      }],
    });

    // Generate the DOCX file
    const buffer = await docx.Packer.toBuffer(doc);

    // Set headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${finalFileName}.docx"`);
    res.setHeader('Content-Length', buffer.length);
    
    // Send the buffer
    res.send(buffer);
    
  } catch (err) {
    console.error("DOC generation error:", err);
    res.status(500).json({ error: "Failed to generate DOC: " + err.message });
  }
});
// Helper function to create clean HTML for DOCX
const createCleanHtmlForDocx = (resumeData) => {
  const { name, contactInfo, summary, experience, skills, education, projects, certifications, languages } = resumeData;

  return `
    <div class="resume-container">
      <div class="header">
        ${name ? `<div class="name">${name}</div>` : ''}
        ${contactInfo ? `<div class="contact-info">${contactInfo}</div>` : ''}
      </div>

      ${summary ? `
      <div class="section">
        <div class="section-title">SUMMARY</div>
        <div>${summary}</div>
      </div>
      ` : ''}

      ${experience && experience.length > 0 ? `
      <div class="section">
        <div class="section-title">EXPERIENCE</div>
        ${experience.map(exp => `
          <div class="experience-item">
            <div class="company">${exp.company || ''}</div>
            <div class="role">${exp.role || ''}</div>
            ${exp.startDate || exp.endDate ? `
            <div class="date">${exp.startDate || ''} - ${exp.endDate || 'Present'}</div>
            ` : ''}
            ${exp.bullets && exp.bullets.length > 0 ? `
            <ul>
              ${exp.bullets.map(bullet => `<li>${bullet}</li>`).join('')}
            </ul>
            ` : ''}
          </div>
        `).join('')}
      </div>
      ` : ''}

      ${education && education.length > 0 ? `
      <div class="section">
        <div class="section-title">EDUCATION</div>
        ${education.map(edu => `
          <div class="education-item">
            <div class="institution">${edu.institution || ''}</div>
            <div class="degree">${edu.degree || ''}</div>
            ${edu.year ? `<div class="date">${edu.year}</div>` : ''}
          </div>
        `).join('')}
      </div>
      ` : ''}

      ${skills && skills.length > 0 ? `
      <div class="section">
        <div class="section-title">SKILLS</div>
        <ul class="skills-list">
          ${skills.map(skill => `<li>${skill}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${projects && projects.length > 0 ? `
      <div class="section">
        <div class="section-title">PROJECTS</div>
        ${projects.map(project => `
          <div class="project-item">
            <div class="project-name">${project.name || ''}</div>
            <div>${project.description || ''}</div>
          </div>
        `).join('')}
      </div>
      ` : ''}

      ${certifications && certifications.length > 0 ? `
      <div class="section">
        <div class="section-title">CERTIFICATIONS</div>
        <ul class="certifications-list">
          ${certifications.map(cert => `<li>${cert}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${languages && languages.length > 0 ? `
      <div class="section">
        <div class="section-title">LANGUAGES</div>
        <ul class="languages-list">
          ${languages.map(lang => `<li>${lang}</li>`).join('')}
        </ul>
      </div>
      ` : ''}
    </div>
  `;
};

// Then update the DOCX endpoint to use this function
app.post("/api/generate-doc", async (req, res) => {
  try {
    const { resumeData } = req.body; // Now we need to send the full resumeData
    
    let finalFileName = "resume";
    if (resumeData && resumeData.name) {
      finalFileName = resumeData.name
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
    }

    const cleanHtml = createCleanHtmlForDocx(resumeData);
    
    const fileBuffer = await htmlToDocx(cleanHtml, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });

    // Set headers and send response...
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${finalFileName}.docx"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.send(fileBuffer);
    
  } catch (err) {
    console.error("DOC generation error:", err);
    res.status(500).json({ error: "Failed to generate DOC" });
  }
});
// Generate PDF Endpoint
// Generate PDF Endpoint - UPDATED VERSION
// Generate PDF Endpoint - FIXED VERSION
// Generate PDF Endpoint - FIXED HEADER VERSION
app.post("/api/generate-pdf", async (req, res) => {
  try {
    const { html, fileName, resumeData } = req.body;
    console.log("Received data:", { fileName, resumeData });

    let finalFileName = "resume";
    
    if (resumeData && resumeData.name) {
      finalFileName = resumeData.name
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
    } 
    else if (fileName) {
      finalFileName = fileName
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
    }

    console.log("Final filename:", finalFileName);

     // Use chromium for Render deployment
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });


    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600 });
    
    const tailwindCDN = "https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css";

    const fullHtml = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${finalFileName}</title>
    <link href="${tailwindCDN}" rel="stylesheet">
    <style>
      @page {
        size: A4;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
      }
      .pdf-page {
        width: 210mm;
        height: 297mm;
        box-sizing: border-box;
        padding: 0;
        background: white;
      }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  </head>
  <body>
    <div class="pdf-page">
      ${html}
    </div>
  </body>
</html>
`;

    await page.setContent(fullHtml, { 
      waitUntil: ['networkidle0', 'domcontentloaded'] 
    });

    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '0mm',
        left: '0mm'
      }
    });

    await browser.close();

    // FIX: Set headers BEFORE sending the response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${finalFileName}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    
    // Send the buffer directly
    res.send(pdfBuffer);
    
  } catch (err) {
    console.error("Puppeteer PDF error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// Generate Resume Endpoint
app.post("/api/resume/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Please provide your career details." });
    }

    const messages = [
      {
        role: "system",
        content: `You are a professional resume writer with 15 years of experience. 
Write in a natural, human-readable, and professional tone suitable for recruiters. 
Avoid overused adjectives and generic phrases like "highly motivated" or "hardworking". 
Focus on concrete achievements, measurable results, and relevant responsibilities. 
Expand the Professional Summary into 9 to 10 lines and Experience sections with meaningful details.
Return a valid json object (must be valid json) with this exact structure:
{
  "name": string,
  "contactInfo": string,
  "summary": string,
  "experienceBullets": [
    { "company": string, "role": string, "startDate": string, "endDate": string, "bullets": string[] }
  ],
  "skills": string[],
  "education": [
    { "degree": string, "institution": string, "year": string }
  ],
  "projects": [
    { "name": string, "description": string }
  ],
  "certifications": string[],
  "languages": string[],
  "tools": string[],
  "resumeMarkdown": string
}
Only return valid json — no markdown outside of the "resumeMarkdown" field.`
      },
      {
        role: "user",
        content: `Using the following career details, create a complete professional resume and output it as valid json: ${prompt}`
      }
    ];

    const groqResponse = await callGroq(messages);
    const resultContent = groqResponse?.choices?.[0]?.message?.content;

    if (!resultContent) {
      throw new Error("Groq API returned empty content");
    }

    let parsed;
    try {
      parsed = JSON.parse(resultContent);
    } catch (e) {
      throw new Error(`Invalid JSON returned by Groq: ${resultContent}`);
    }

    res.json(parsed);

  } catch (error) {
    console.error("Resume generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    groqApi: GROQ_API_KEY ? "configured" : "missing",
    environment: process.env.NODE_ENV || "development",
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    timestamp: new Date().toISOString()
  });
  
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: err.message,
    ...(process.env.NODE_ENV === 'development' && {
      details: err.stack
    })
  });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Groq API: ${GROQ_API_KEY ? "Ready" : "NOT CONFIGURED"}`);
});