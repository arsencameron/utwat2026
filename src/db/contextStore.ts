import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface CandidateProfile {
  id?: number;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl?: string;
  workAuthorization: string;
  defaultCoverLetter: string;
  resumePath?: string;
  updatedAt?: string;
}

export interface QARecord {
  id: number;
  question_key: string;
  raw_question: string;
  answer: string;
  created_at: string;
}

export class ContextStore {
  private db: Database.Database;

  constructor(dbPath: string = path.join(process.cwd(), "data", "context.db")) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
    this.seedDefaultProfileIfEmpty();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        location TEXT NOT NULL,
        linkedin_url TEXT NOT NULL,
        github_url TEXT NOT NULL,
        portfolio_url TEXT,
        work_authorization TEXT NOT NULL,
        default_cover_letter TEXT NOT NULL,
        resume_path TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS qa_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_key TEXT UNIQUE NOT NULL,
        raw_question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_qa_question_key ON qa_memory(question_key);
    `);
  }

  private seedDefaultProfileIfEmpty(): void {
    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM candidate_profile")
      .get() as { count: number };

    if (count.count === 0) {
      this.db
        .prepare(`
          INSERT INTO candidate_profile (
            full_name, email, phone, location,
            linkedin_url, github_url, portfolio_url,
            work_authorization, default_cover_letter
          ) VALUES (
            @fullName, @email, @phone, @location,
            @linkedinUrl, @githubUrl, @portfolioUrl,
            @workAuthorization, @defaultCoverLetter
          )
        `)
        .run({
          fullName: "",
          email: "",
          phone: "",
          location: "",
          linkedinUrl: "",
          githubUrl: "",
          portfolioUrl: "",
          workAuthorization: "",
          defaultCoverLetter: "",
        });
    }
  }

  public normalizeKey(question: string): string {
    return question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  public getProfile(): CandidateProfile {
    const row = this.db
      .prepare(`
        SELECT 
          id,
          full_name AS fullName,
          email,
          phone,
          location,
          linkedin_url AS linkedinUrl,
          github_url AS githubUrl,
          portfolio_url AS portfolioUrl,
          work_authorization AS workAuthorization,
          default_cover_letter AS defaultCoverLetter,
          resume_path AS resumePath,
          updated_at AS updatedAt
        FROM candidate_profile
        ORDER BY id DESC
        LIMIT 1
      `)
      .get() as CandidateProfile | undefined;

    if (!row) {
      throw new Error("Candidate profile not found");
    }
    return row;
  }

  public updateProfile(updates: Partial<CandidateProfile>): void {
    const current = this.getProfile();
    const cleanString = (val: unknown, fallback: string): string => {
      if (val === null || val === undefined) return fallback;
      return String(val).trim();
    };

    const sanitized = {
      id: current.id,
      fullName: cleanString(updates.fullName, current.fullName || ""),
      email: cleanString(updates.email, current.email || ""),
      phone: cleanString(updates.phone, current.phone || ""),
      location: cleanString(updates.location, current.location || ""),
      linkedinUrl: cleanString(updates.linkedinUrl, current.linkedinUrl || ""),
      githubUrl: cleanString(updates.githubUrl, current.githubUrl || ""),
      portfolioUrl: cleanString(updates.portfolioUrl, current.portfolioUrl || ""),
      workAuthorization: cleanString(updates.workAuthorization, current.workAuthorization || ""),
      defaultCoverLetter: cleanString(updates.defaultCoverLetter, current.defaultCoverLetter || ""),
      resumePath:
        updates.resumePath !== undefined && updates.resumePath !== null
          ? String(updates.resumePath).trim()
          : current.resumePath || "",
    };

    this.db
      .prepare(`
        UPDATE candidate_profile
        SET full_name = @fullName,
            email = @email,
            phone = @phone,
            location = @location,
            linkedin_url = @linkedinUrl,
            github_url = @githubUrl,
            portfolio_url = @portfolioUrl,
            work_authorization = @workAuthorization,
            default_cover_letter = @defaultCoverLetter,
            resume_path = @resumePath,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `)
      .run(sanitized);
  }

  /**
   * Look up an answer by question.
   * Performs:
   * 1. Exact normalized key match.
   * 2. Substring / LIKE match.
   * 3. Keyword overlap token match.
   */
  public findAnswer(question: string): string | null {
    const key = this.normalizeKey(question);
    if (!key) return null;

    // 1. Exact key match
    const exactMatch = this.db
      .prepare("SELECT answer FROM qa_memory WHERE question_key = ?")
      .get(key) as { answer: string } | undefined;

    if (exactMatch) {
      return exactMatch.answer;
    }

    // 2. Substring match
    const substringMatch = this.db
      .prepare("SELECT answer FROM qa_memory WHERE question_key LIKE ? OR ? LIKE ('%' || question_key || '%') LIMIT 1")
      .get(`%${key}%`, key) as { answer: string } | undefined;

    if (substringMatch) {
      return substringMatch.answer;
    }

    // 3. Keyword overlap token match
    const tokens = key.split(" ").filter((t) => t.length > 3);
    if (tokens.length > 0) {
      const allRecords = this.getAllQA();
      let bestMatch: { answer: string; score: number } | null = null;

      for (const rec of allRecords) {
        const recTokens = new Set(rec.question_key.split(" ").filter((t) => t.length > 3));
        let matchCount = 0;
        for (const token of tokens) {
          if (recTokens.has(token)) {
            matchCount++;
          }
        }
        const score = matchCount / Math.max(tokens.length, recTokens.size);
        if (score >= 0.5 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { answer: rec.answer, score };
        }
      }

      if (bestMatch) {
        return bestMatch.answer;
      }
    }

    return null;
  }

  public saveAnswer(question: string, answer: string): void {
    const key = this.normalizeKey(question);
    if (!key) return;

    this.db
      .prepare(`
        INSERT INTO qa_memory (question_key, raw_question, answer, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(question_key) DO UPDATE SET
          raw_question = excluded.raw_question,
          answer = excluded.answer,
          created_at = CURRENT_TIMESTAMP
      `)
      .run(key, question.trim(), answer.trim());
  }

  public getQAById(id: number): QARecord | undefined {
    return this.db
      .prepare("SELECT id, question_key, raw_question, answer, created_at FROM qa_memory WHERE id = ?")
      .get(id) as QARecord | undefined;
  }

  public updateQA(id: number, answer: string, rawQuestion?: string): boolean {
    if (rawQuestion && rawQuestion.trim()) {
      const key = this.normalizeKey(rawQuestion);
      const res = this.db
        .prepare(`
          UPDATE qa_memory
          SET question_key = ?,
              raw_question = ?,
              answer = ?,
              created_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(key, rawQuestion.trim(), answer.trim(), id);
      return res.changes > 0;
    } else {
      const res = this.db
        .prepare(`
          UPDATE qa_memory
          SET answer = ?,
              created_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(answer.trim(), id);
      return res.changes > 0;
    }
  }

  public deleteQA(id: number): boolean {
    const res = this.db.prepare("DELETE FROM qa_memory WHERE id = ?").run(id);
    return res.changes > 0;
  }

  public clearAllQA(): number {
    const res = this.db.prepare("DELETE FROM qa_memory").run();
    return res.changes;
  }

  public getAllQA(): QARecord[] {
    return this.db
      .prepare("SELECT id, question_key, raw_question, answer, created_at FROM qa_memory ORDER BY id DESC")
      .all() as QARecord[];
  }

  public exportData(): { profile: CandidateProfile; qaMemory: QARecord[] } {
    return {
      profile: this.getProfile(),
      qaMemory: this.getAllQA(),
    };
  }

  public importQA(records: Array<{ raw_question?: string; question?: string; answer: string }>): number {
    let imported = 0;
    const insert = this.db.prepare(`
      INSERT INTO qa_memory (question_key, raw_question, answer, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(question_key) DO UPDATE SET
        raw_question = excluded.raw_question,
        answer = excluded.answer,
        created_at = CURRENT_TIMESTAMP
    `);

    const transaction = this.db.transaction((items: typeof records) => {
      for (const item of items) {
        const q = item.raw_question || item.question;
        if (q && item.answer) {
          const key = this.normalizeKey(q);
          if (key) {
            insert.run(key, q.trim(), item.answer.trim());
            imported++;
          }
        }
      }
    });

    transaction(records);
    return imported;
  }

  public close(): void {
    this.db.close();
  }
}

export const contextStore = new ContextStore();
