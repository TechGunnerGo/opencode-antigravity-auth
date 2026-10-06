import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  deduplicateAccountsByEmail,
  migrateV2ToV3,
  loadAccounts,
  removeAccountFromStorage,
  saveAccounts,
  saveAccountsRuntimeState,
  type AccountMetadata,
  type AccountStorage,
  type AccountStorageV4,
} from "./storage";
import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  },
}));

describe("deduplicateAccountsByEmail", () => {
  it("returns empty array for empty input", () => {
    const result = deduplicateAccountsByEmail([]);
    expect(result).toEqual([]);
  });

  it("returns single account unchanged", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "test@example.com",
        refreshToken: "r1",
        addedAt: 1000,
        lastUsed: 2000,
      },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toEqual(accounts);
  });

  it("keeps accounts without email (cannot deduplicate)", () => {
    const accounts: AccountMetadata[] = [
      { refreshToken: "r1", addedAt: 1000, lastUsed: 2000 },
      { refreshToken: "r2", addedAt: 1100, lastUsed: 2100 },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(2);
    expect(result[0]?.refreshToken).toBe("r1");
    expect(result[1]?.refreshToken).toBe("r2");
  });

  it("deduplicates accounts with same email, keeping newest by lastUsed", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "test@example.com",
        refreshToken: "old-token",
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: "test@example.com",
        refreshToken: "new-token",
        addedAt: 2000,
        lastUsed: 3000,
      },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(1);
    expect(result[0]?.refreshToken).toBe("new-token");
    expect(result[0]?.email).toBe("test@example.com");
  });

  it("deduplicates accounts with same email, keeping newest by addedAt when lastUsed is equal", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "test@example.com",
        refreshToken: "old-token",
        addedAt: 1000,
        lastUsed: 0,
      },
      {
        email: "test@example.com",
        refreshToken: "new-token",
        addedAt: 2000,
        lastUsed: 0,
      },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(1);
    expect(result[0]?.refreshToken).toBe("new-token");
  });

  it("handles multiple duplicate emails correctly", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "alice@example.com",
        refreshToken: "alice-old",
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: "bob@example.com",
        refreshToken: "bob-old",
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: "alice@example.com",
        refreshToken: "alice-new",
        addedAt: 2000,
        lastUsed: 3000,
      },
      {
        email: "bob@example.com",
        refreshToken: "bob-new",
        addedAt: 2000,
        lastUsed: 3000,
      },
      {
        email: "alice@example.com",
        refreshToken: "alice-mid",
        addedAt: 1500,
        lastUsed: 2000,
      },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(2);

    const alice = result.find((a) => a.email === "alice@example.com");
    const bob = result.find((a) => a.email === "bob@example.com");

    expect(alice?.refreshToken).toBe("alice-new");
    expect(bob?.refreshToken).toBe("bob-new");
  });

  it("preserves order of kept accounts based on newest entry index", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "first@example.com",
        refreshToken: "first-old",
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: "second@example.com",
        refreshToken: "second-new",
        addedAt: 3000,
        lastUsed: 3000,
      },
      {
        email: "first@example.com",
        refreshToken: "first-new",
        addedAt: 2000,
        lastUsed: 2000,
      },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(2);
    // Kept entries are at indices 1 (second@) and 2 (first@), so order is second, first
    expect(result[0]?.email).toBe("second@example.com");
    expect(result[1]?.email).toBe("first@example.com");
  });

  it("mixes accounts with and without email correctly", () => {
    const accounts: AccountMetadata[] = [
      {
        email: "test@example.com",
        refreshToken: "r1",
        addedAt: 1000,
        lastUsed: 1000,
      },
      { refreshToken: "no-email-1", addedAt: 1500, lastUsed: 1500 },
      {
        email: "test@example.com",
        refreshToken: "r2",
        addedAt: 2000,
        lastUsed: 2000,
      },
      { refreshToken: "no-email-2", addedAt: 2500, lastUsed: 2500 },
    ];
    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(3);

    // no-email-1 at index 1
    // r2 (newest for test@example.com) at index 2
    // no-email-2 at index 3
    expect(result[0]?.refreshToken).toBe("no-email-1");
    expect(result[1]?.refreshToken).toBe("r2");
    expect(result[2]?.refreshToken).toBe("no-email-2");
  });

  it("handles exact scenario from issue #24 (11 duplicate accounts)", () => {
    // Simulate user logging in 11 times with the same account
    const accounts: AccountMetadata[] = [];
    for (let i = 0; i < 11; i++) {
      accounts.push({
        email: "user@example.com",
        refreshToken: `token-${i}`,
        addedAt: 1000 + i * 100,
        lastUsed: 1000 + i * 100,
      });
    }

    const result = deduplicateAccountsByEmail(accounts);
    expect(result).toHaveLength(1);
    expect(result[0]?.refreshToken).toBe("token-10"); // The newest one
    expect(result[0]?.email).toBe("user@example.com");
  });
});

describe("removeAccountFromStorage", () => {
  it("removes only the revoked identity while preserving concurrently added accounts", async () => {
    const stored = {
      version: 4,
      accounts: [
        { refreshToken: "revoked", email: "revoked@example.com", addedAt: 1, lastUsed: 1 },
        { refreshToken: "existing", email: "existing@example.com", addedAt: 2, lastUsed: 2 },
        { refreshToken: "concurrent", email: "concurrent@example.com", addedAt: 3, lastUsed: 3 },
      ],
      activeIndex: 2,
      activeIndexByFamily: { claude: 1, gemini: 2 },
    } satisfies AccountStorageV4;
    vi.mocked(fs.readFile).mockImplementation(async (path) => {
      if (String(path).endsWith(".gitignore")) {
        return [
          "antigravity-accounts.json",
          "antigravity-accounts.json.*.tmp",
          "antigravity-signature-cache.json",
          "antigravity-logs/",
        ].join("\n");
      }
      return JSON.stringify(stored);
    });

    await removeAccountFromStorage("revoked");

    const saveCall = vi.mocked(fs.writeFile).mock.calls.find(
      ([path]) => String(path).includes(".tmp"),
    );
    if (!saveCall) throw new Error("Account storage was not written");
    const saved = JSON.parse(String(saveCall[1])) as AccountStorageV4;
    expect(saved.accounts.map((account) => account.refreshToken)).toEqual(["existing", "concurrent"]);
    expect(saved.activeIndex).toBe(1);
    expect(saved.activeIndexByFamily).toEqual({ claude: 0, gemini: 1 });
  });

  it("does not resurrect a removed account when a stale snapshot saves later", async () => {
    const initial: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "revoked", addedAt: 1, lastUsed: 1 },
        { refreshToken: "valid", addedAt: 2, lastUsed: 2 },
      ],
      activeIndex: 1,
      activeIndexByFamily: { claude: 1, gemini: 1 },
    };
    let diskContent = JSON.stringify(initial);
    vi.mocked(fs.readFile).mockImplementation(async (path) => {
      if (String(path).endsWith(".gitignore")) return "";
      return diskContent;
    });
    vi.mocked(fs.writeFile).mockImplementation(async (path, data) => {
      if (String(path).includes(".tmp")) diskContent = String(data);
    });

    await removeAccountFromStorage("revoked");
    await saveAccounts(initial);

    const saved = JSON.parse(diskContent) as AccountStorageV4;
    expect(saved.accounts.map((account) => account.refreshToken)).toEqual(["valid"]);
    expect(saved.activeIndex).toBe(0);
    expect(saved.activeIndexByFamily).toEqual({ claude: 0, gemini: 0 });
    expect(diskContent).not.toContain("revoked");
  });
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

describe("Storage Migration", () => {
  const now = Date.now();
  const future = now + 100000;
  const past = now - 100000;

  describe("migrateV2ToV3", () => {

    it("drops rate limits (quota state is in-memory only)", () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: future,
              gemini: past,
            },
          },
        ],
        activeIndex: 0,
      };

      const account = migrateV2ToV3(v2).accounts[0];
      if (!account) throw new Error("Account not found");

      expect(account.refreshToken).toBe("r1");
      expect("rateLimitResetTimes" in account).toBe(false);
    });
  });

  describe("loadAccounts migration integration", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("keeps the selected account when email deduplication reorders accounts", async () => {
      // Given: the persisted index selects B between two versions of A.
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 4,
          accounts: [
            {
              email: "a@example.com",
              refreshToken: "a-old",
              addedAt: 1,
              lastUsed: 1,
            },
            {
              email: "b@example.com",
              refreshToken: "b",
              addedAt: 2,
              lastUsed: 2,
            },
            {
              email: "a@example.com",
              refreshToken: "a-new",
              addedAt: 3,
              lastUsed: 3,
            },
          ],
          activeIndex: 1,
        }),
      );

      // When: storage is loaded and A's old entry is removed.
      const result = await loadAccounts();

      // Then: B remains the active account even though it moved to index zero.
      expect(result?.accounts.map((account) => account.email)).toEqual([
        "b@example.com",
        "a@example.com",
      ]);
      expect(result?.activeIndex).toBe(0);
      expect(result?.accounts[result.activeIndex ?? 0]?.email).toBe(
        "b@example.com",
      );
    });

    it("remaps family selections by account identity after email deduplication", async () => {
      // Given: Claude selects A while Gemini selects B in the persisted ordering.
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 4,
          accounts: [
            {
              email: "a@example.com",
              refreshToken: "a-old",
              addedAt: 1,
              lastUsed: 1,
            },
            {
              email: "b@example.com",
              refreshToken: "b",
              addedAt: 2,
              lastUsed: 2,
            },
            {
              email: "a@example.com",
              refreshToken: "a-new",
              addedAt: 3,
              lastUsed: 3,
            },
          ],
          activeIndex: 0,
          activeIndexByFamily: {
            claude: 0,
            gemini: 1,
          },
        }),
      );

      // When: storage is loaded and duplicate emails are compacted.
      const result = await loadAccounts();

      // Then: family choices still resolve to their originally selected emails.
      expect(result?.activeIndex).toBe(1);
      expect(result?.activeIndexByFamily).toEqual({
        claude: 1,
        gemini: 0,
      });
      expect(
        result?.accounts[result.activeIndexByFamily?.claude ?? 0]?.email,
      ).toBe("a@example.com");
      expect(
        result?.accounts[result.activeIndexByFamily?.gemini ?? 0]?.email,
      ).toBe("b@example.com");
    });

    it("migrates V2 storage on load and persists V4 without quota state", async () => {
      const v2Data = {
        version: 2,
        accounts: [
          {
            refreshToken: "r1",
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      };

      // Mock readFile to return different values based on path
      vi.mocked(fs.readFile).mockImplementation((path) => {
        if ((path as string).endsWith(".gitignore")) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          return Promise.reject(error);
        }
        return Promise.resolve(JSON.stringify(v2Data));
      });

      const result = await loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(4);

      const account = result?.accounts[0];
      if (!account) throw new Error("Account not found");

      expect("rateLimitResetTimes" in account).toBe(false);

      expect(fs.writeFile).toHaveBeenCalled();
      
      const saveCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes(".tmp")
      );
      if (!saveCall) throw new Error("saveAccounts was not called (tmp file not found)");

      const savedContent = JSON.parse(saveCall[1] as string);
      expect(savedContent.version).toBe(4);
      expect(savedContent.accounts[0].refreshToken).toBe("r1");
      expect(savedContent.accounts[0].rateLimitResetTimes).toBeUndefined();

      const gitignoreCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes(".gitignore")
      );
      expect(gitignoreCall).toBeDefined();
    });
  });

  describe("ensureGitignore", () => {
    const configDir = "/tmp/opencode-test";

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("creates .gitignore when file does not exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const { ensureGitignore } = await import("./storage");
      await ensureGitignore(configDir);

      expect(fs.writeFile).toHaveBeenCalled();
      const [path, content] = vi.mocked(fs.writeFile).mock.calls[0]!;
      expect(path).toContain(".gitignore");
      expect(content).toContain("antigravity-accounts.json");
      expect(content).toContain("antigravity-signature-cache.json");
      expect(content).toContain("antigravity-logs/");
    });

    it("appends missing entries to existing .gitignore", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("existing-entry");

      const { ensureGitignore } = await import("./storage");
      await ensureGitignore(configDir);

      expect(fs.appendFile).toHaveBeenCalled();
      const [path, content] = vi.mocked(fs.appendFile).mock.calls[0]!;
      expect(path).toContain(".gitignore");
      expect(content).toContain("antigravity-accounts.json");
      expect((content as string).startsWith("\n")).toBe(true);
    });

    it("does nothing when all entries already exist", async () => {
      const existing = [
        ".gitignore",
        "antigravity-accounts.json",
        "antigravity-accounts.json.*.tmp",
        "antigravity-signature-cache.json",
        "antigravity-logs/",
      ].join("\n");
      vi.mocked(fs.readFile).mockResolvedValue(existing);

      const { ensureGitignore } = await import("./storage");
      await ensureGitignore(configDir);

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.appendFile).not.toHaveBeenCalled();
    });

    it("handles permission errors gracefully", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "EACCES" });

      const { ensureGitignore } = await import("./storage");
      await expect(ensureGitignore(configDir)).resolves.not.toThrow();

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.appendFile).not.toHaveBeenCalled();
    });
  });

  describe("ensureGitignoreSync", () => {
    const configDir = "/tmp/opencode-test-sync";

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("creates .gitignore when file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { ensureGitignoreSync } = await import("./storage");
      ensureGitignoreSync(configDir);

      expect(writeFileSync).toHaveBeenCalled();
      const [path, content] = vi.mocked(writeFileSync).mock.calls[0]!;
      expect(path).toContain(".gitignore");
      expect(content).toContain("antigravity-accounts.json");
      expect(content).toContain("antigravity-signature-cache.json");
      expect(content).toContain("antigravity-logs/");
    });

    it("appends missing entries to existing .gitignore", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("existing-entry");

      const { ensureGitignoreSync } = await import("./storage");
      ensureGitignoreSync(configDir);

      expect(appendFileSync).toHaveBeenCalled();
      const [path, content] = vi.mocked(appendFileSync).mock.calls[0]!;
      expect(path).toContain(".gitignore");
      expect(content).toContain("antigravity-accounts.json");
      expect((content as string).startsWith("\n")).toBe(true);
    });

    it("does nothing when all entries already exist", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const existing = [
        ".gitignore",
        "antigravity-accounts.json",
        "antigravity-accounts.json.*.tmp",
        "antigravity-signature-cache.json",
        "antigravity-logs/",
      ].join("\n");
      vi.mocked(readFileSync).mockReturnValue(existing);

      const { ensureGitignoreSync } = await import("./storage");
      ensureGitignoreSync(configDir);

      expect(writeFileSync).not.toHaveBeenCalled();
      expect(appendFileSync).not.toHaveBeenCalled();
    });
  });
});

describe("saveAccounts merge — cleared rate limits are not resurrected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Disk content is raw parsed JSON, so legacy fields can be modeled verbatim. */
  function mockDisk(existing: AccountStorageV4 | Record<string, unknown>): void {
    vi.mocked(fs.readFile).mockImplementation((path) => {
      if ((path as string).endsWith(".gitignore")) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        return Promise.reject(error);
      }
      return Promise.resolve(JSON.stringify(existing));
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  }

  function readMergedSnapshot(): AccountStorageV4 {
    const tmpCall = vi.mocked(fs.writeFile).mock.calls.find(
      (call) => (call[0] as string).includes(".tmp"),
    );
    if (!tmpCall) throw new Error("atomic write (tmp file) not found");
    return JSON.parse(tmpCall[1] as string) as AccountStorageV4;
  }

  it("strips legacy quota/limit fields an older writer left on disk", async () => {
    mockDisk({
      version: 4,
      accounts: [
        {
          email: "a@example.com",
          refreshToken: "r1",
          addedAt: 1,
          lastUsed: 5,
          // Written by a plugin version that persisted quota/limit state.
          rateLimitResetTimes: { claude: 9_999_999_999_999 },
          rateLimitSetTimes: { claude: 9_999_999_999_000 },
          clearedQuotaKeys: { gemini: 9_999_999_999_000 },
          clearedSetTimes: { gemini: 9_999_999_998_000 },
          coolingDownUntil: 9_999_999_999_999,
          cooldownReason: "auth-failure",
          cachedQuota: { claude: { remainingFraction: 0.1, modelCount: 3 } },
          cachedQuotaUpdatedAt: 9_999_999_999_999,
        },
      ],
      activeIndex: 0,
    });

    await saveAccounts({
      version: 4,
      accounts: [
        { email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 6 },
      ],
      activeIndex: 0,
    });

    const LEGACY_TRANSIENT_FIELDS = [
      "rateLimitResetTimes",
      "rateLimitSetTimes",
      "clearedQuotaKeys",
      "clearedSetTimes",
      "coolingDownUntil",
      "cooldownReason",
      "cachedQuota",
      "cachedQuotaUpdatedAt",
    ];
    const persisted = readMergedSnapshot().accounts[0] as unknown as Record<string, unknown>;
    for (const field of LEGACY_TRANSIENT_FIELDS) {
      expect(persisted[field]).toBeUndefined();
    }
    // Administrative state is untouched.
    expect(persisted.email).toBe("a@example.com");
    expect(persisted.lastUsed).toBe(6);
  });

  it("still unions accounts from the in-memory snapshot and disk", async () => {
    mockDisk({
      version: 4,
      accounts: [
        { email: "disk@example.com", refreshToken: "disk", addedAt: 1, lastUsed: 5 },
      ],
      activeIndex: 0,
    });

    await saveAccounts({
      version: 4,
      accounts: [
        {
          email: "mem@example.com",
          refreshToken: "mem",
          addedAt: 2,
          lastUsed: 6,
        },
      ],
      activeIndex: 0,
    });

    const merged = readMergedSnapshot();
    const tokens = merged.accounts.map((a) => a.refreshToken).sort();
    expect(tokens).toEqual(["disk", "mem"]);
  });

  it("preserves a newer enabled state against a stale process snapshot", async () => {
    mockDisk({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 5,
        enabled: true,
        enabledUpdatedAt: 200,
      }],
      activeIndex: 0,
    });

    await saveAccounts({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 6,
        enabled: false,
        enabledUpdatedAt: 100,
      }],
      activeIndex: 0,
    });

    const account = readMergedSnapshot().accounts[0];
    expect(account?.enabled).toBe(true);
    expect(account?.enabledUpdatedAt).toBe(200);
  });

  it("applies a newer disabled state over an older enabled state", async () => {
    mockDisk({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 5,
        enabled: true,
        enabledUpdatedAt: 100,
      }],
      activeIndex: 0,
    });

    await saveAccounts({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 6,
        enabled: false,
        enabledUpdatedAt: 200,
      }],
      activeIndex: 0,
    });

    const account = readMergedSnapshot().accounts[0];
    expect(account?.enabled).toBe(false);
    expect(account?.enabledUpdatedAt).toBe(200);
  });

  it("prefers a timestamped toggle over a legacy snapshot without a timestamp", async () => {
    mockDisk({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 5,
        enabled: true,
        enabledUpdatedAt: 200,
      }],
      activeIndex: 0,
    });

    await saveAccounts({
      version: 4,
      accounts: [{
        refreshToken: "r1",
        addedAt: 1,
        lastUsed: 6,
        enabled: false,
      }],
      activeIndex: 0,
    });

    const account = readMergedSnapshot().accounts[0];
    expect(account?.enabled).toBe(true);
    expect(account?.enabledUpdatedAt).toBe(200);
  });

  describe("saveAccountsRuntimeState", () => {
    it("saveAccountsRuntimeState updates operational fields without overwriting administrative identity", async () => {
      mockDisk({
        version: 4,
        accounts: [
          {
            email: "authoritative@example.com",
            refreshToken: "r1",
            projectId: "new-user-project",
            managedProjectId: "new-managed-project",
            addedAt: 100,
            lastUsed: 100,
            enabled: false,
            enabledUpdatedAt: 500,
          },
        ],
        activeIndex: 0,
      });

      await saveAccountsRuntimeState({
        version: 4,
        accounts: [
          {
            email: "stale@example.com",
            refreshToken: "r1",
            projectId: "stale-cached-project",
            managedProjectId: "stale-managed-project",
            addedAt: 1,
            lastUsed: 600,
            enabled: true,
            enabledUpdatedAt: 1,
            reauthRequired: true,
            reauthRequiredAt: 600,
            reauthRequiredReason: "Token revoked or expired (invalid_grant)",
          },
        ],
        activeIndex: 0,
      });

      const merged = readMergedSnapshot();
      expect(merged.accounts[0]?.email).toBe("authoritative@example.com");
      expect(merged.accounts[0]?.projectId).toBe("new-user-project");
      expect(merged.accounts[0]?.managedProjectId).toBe("new-managed-project");
      expect(merged.accounts[0]?.enabled).toBe(false);
      expect(merged.accounts[0]?.enabledUpdatedAt).toBe(500);
      expect(merged.accounts[0]?.lastUsed).toBe(600);
      expect(merged.accounts[0]?.reauthRequired).toBe(true);
      expect(merged.accounts[0]?.reauthRequiredReason).toBe("Token revoked or expired (invalid_grant)");
    });
  });
});
