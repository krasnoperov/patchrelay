export const PACKAGE_SPECS = [
  {
    key: "root",
    npmName: "patchrelay",
    workspace: null,
    packageJson: "package.json",
    ownsFile(file) {
      if (file.startsWith("packages/")) return false;
      if (file.startsWith(".github/")) return false;
      if (file.startsWith("test/")) return false;
      if (file.startsWith("docs/")) return false;
      if (file.endsWith(".md")) return false;
      return (
        file === "package.json"
        || file === "pnpm-lock.yaml"
        || file === "tsconfig.json"
        || file === "runtime.env.example"
        || file === "service.env.example"
        || file.startsWith("src/")
        || file.startsWith("config/")
        || file.startsWith("infra/")
        || file.startsWith("scripts/")
      );
    },
  },
  {
    key: "steward",
    npmName: "merge-steward",
    workspace: "packages/merge-steward",
    packageJson: "packages/merge-steward/package.json",
    ownsFile(file) {
      return file.startsWith("packages/merge-steward/");
    },
  },
  {
    key: "review_quill",
    npmName: "review-quill",
    workspace: "packages/review-quill",
    packageJson: "packages/review-quill/package.json",
    ownsFile(file) {
      return file.startsWith("packages/review-quill/");
    },
  },
];

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  return Math.sign(a.patch - b.patch);
}

export function conventionalBump(subject) {
  if (/^[a-z]+(\([^)]*\))?!:/.test(subject)) return "major";
  const match = /^([a-z]+)(\([^)]*\))?:/.exec(subject);
  if (match?.[1] === "feat") return "minor";
  return "patch";
}

export function applyPreMajor(bump, version) {
  return version.startsWith("0.") && bump === "major" ? "minor" : bump;
}

export function incrementVersion(version, bump) {
  const parsed = parseVersion(version);
  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function highestBump(subjects, version) {
  let bump = "patch";
  for (const subject of subjects) {
    const candidate = conventionalBump(subject);
    if ((BUMP_RANK[candidate] ?? 0) > (BUMP_RANK[bump] ?? 0)) {
      bump = candidate;
    }
  }
  return applyPreMajor(bump, version);
}

export function planPackageRelease({ localVersion, publishedVersion, relevantSubjects }) {
  if (!publishedVersion) {
    return {
      release: true,
      publish: true,
      nextVersion: localVersion,
      reason: "first_publish",
    };
  }

  const comparison = compareVersions(localVersion, publishedVersion);
  if (comparison > 0) {
    return {
      release: true,
      publish: true,
      nextVersion: localVersion,
      reason: "manual_version_bump",
    };
  }

  if (comparison < 0) {
    return {
      release: false,
      publish: false,
      nextVersion: localVersion,
      reason: "published_version_ahead_of_repo",
    };
  }

  if (relevantSubjects.length === 0) {
    return {
      release: false,
      publish: false,
      nextVersion: localVersion,
      reason: "no_relevant_changes",
    };
  }

  const bump = highestBump(relevantSubjects, localVersion);
  return {
    release: true,
    publish: true,
    nextVersion: incrementVersion(localVersion, bump),
    reason: `bump_${bump}`,
  };
}
