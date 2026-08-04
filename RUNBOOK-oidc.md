# RUNBOOK — Replace long-lived AWS keys with GitHub OIDC

**Target:** `gchis66/portfolio-site` → AWS account (us-east-1)
**Removes:** `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` GitHub secrets + the IAM user behind them
**Time:** ~45 min
**Prereqs:** ⚠️ §0 (commit real `lambda/index.js`) and ⚠️ §0b (stop the deploy deleting your resume) — both before anything else

---

## 0. PREREQ — do not skip

`lambda/index.js` in the repo is **0 bytes**, but `VisitorCountFunc` works in production. The real code exists only in AWS.

`deploy-lambda.yml` fires on any push touching `lambda/**` and runs `aws lambda update-function-code`. If it fires with an empty `index.js`, the view counter breaks.

1. AWS Console → Lambda → `VisitorCountFunc`
2. **Actions → Export function → Download deployment package**
3. Unzip, copy the real source into `PortfolioSite/lambda/`
4. Commit it (this push touches `lambda/**`, so the old workflow will run and redeploy identical code — harmless, and it proves the pipeline still works before you change auth)

**Status: ✔ done (29 Jul 2026)**

---

## 0b. PREREQ — the deploy is deleting your resume

### The bug

`deploy-website.yml`:

```
aws s3 sync --delete ./prod s3://gregorychisholm.com
```

`--delete` makes the bucket an **exact mirror** of `./prod`. Any object present in the bucket but absent from `./prod` is deleted on every deploy.

`./prod` contains **only `index.html`**. So every push to `main` deletes:
- `Gregory_Chisholm_Resume.pdf` — which `index.html` links to as `/Gregory_Chisholm_Resume.pdf`
- any other hand-uploaded object (favicon, error page, images, old assets)

Net effect: the **Resume (PDF)** button on the live site is broken from the moment a deploy runs until the file is manually re-uploaded. It is broken right now for anyone who visits after the last deploy.

### Fix — commit the resume into the repo (recommended)

Make the repo the single source of truth for everything the bucket serves. This is the correct fix, not a workaround: right now your production bucket holds state that exists nowhere else, which means a deploy can destroy content you can't restore from version control.

1. Put the current resume PDF at `PortfolioSite/prod/Gregory_Chisholm_Resume.pdf`
   - If the bucket copy is the only copy, download it from S3 first: bucket → object → **Download**
2. **Audit the bucket for other orphans** before the next deploy — anything listed in S3 but not in `prod/` will be destroyed:
   - Console → S3 → `gregorychisholm.com` → review every object
   - Common finds: `favicon.ico`, `error.html`, `robots.txt`, `404.html`, images, old `assets/`
   - Copy each into `prod/`, preserving the same key path (an object at `assets/img/x.png` goes to `prod/assets/img/x.png`)
3. Commit them. `git status` should show the PDF plus any recovered files.
4. Deploy and verify `https://gregorychisholm.com/Gregory_Chisholm_Resume.pdf` still loads.

**Why this over `--exclude`:** you *want* `--delete`, because it's what removes files you intentionally delete from the repo. Excluding the PDF would keep the bug alive in a quieter form — an untracked production asset that no one can restore. Commit it and the problem is structurally gone.

Also: this is the same reason the DripCheck case study and the new `/talk` page must live in `prod/`. Anything not in `prod/` does not survive a deploy.

**Status: ✔ done (29 Jul 2026)**

### Alternative — if you refuse to version the PDF

If you'd rather keep the resume out of git (e.g. you update it often and don't want the churn):

```yaml
      - name: Sync to S3
        run: |
          aws s3 sync --delete ./prod s3://gregorychisholm.com \
            --exclude "Gregory_Chisholm_Resume.pdf"
```

`--exclude` applies to both sides of the comparison, so the object is left untouched in the bucket. Downside: that file now exists only in S3, with no version history and no local copy. If you take this route, **enable S3 versioning on the bucket** so a mistaken delete is recoverable.

### Verify after either fix

```
# should return 200 and application/pdf
curl -sI https://gregorychisholm.com/Gregory_Chisholm_Resume.pdf | head -3
```

Do this once *before* the OIDC migration and once after, so you know a later failure came from the auth change and not from this.

---

## 1. Why OIDC — the benefits

| | Long-lived keys (today) | OIDC (after) |
|---|---|---|
| **Credential lifetime** | Forever, until manually rotated | ~1 hour, minted per workflow run |
| **Where it lives** | Encrypted in GitHub secrets, plus wherever else it was pasted | Nowhere. Nothing to store. |
| **If leaked** | Attacker has your AWS account until you notice and rotate | Token already expired |
| **Rotation** | Manual, and you will forget | N/A — no secret exists |
| **Who can use it** | Anyone holding the string | Only a workflow from a specific repo + branch |
| **Audit trail** | `AssumeRole` by an IAM user — anonymous | CloudTrail shows which repo, branch, and workflow run assumed the role |

The mechanism: GitHub Actions mints a short-lived signed JWT describing the run (repo, branch, workflow). AWS is configured to trust GitHub as an identity provider, verifies the signature, checks the claims against your trust policy, and issues temporary STS credentials. No shared secret ever exists.

**Why it matters beyond hygiene:** static access keys in CI are one of the most common real-world AWS compromise vectors. This is also the single most credible "security hardening" line you can put on a résumé for the roles you're targeting — it's specific, verifiable, and every cloud interviewer knows what it means.

**Second win, equally important:** the current IAM user almost certainly has broader permissions than the two workflows need. You're replacing it with a role that can do exactly six things and nothing else.

---

## 2. Gather these values first

Write them down; you'll paste them repeatedly.

| Value | Where to find it | Yours |
|---|---|---|
| AWS Account ID | Console top-right account menu (12 digits) | **671175724628** |
| Region | `us-east-1` (matches your API Gateway URL) | `us-east-1` |
| S3 bucket | `gregorychisholm.com` | ✔ |
| CloudFront distribution ID | CloudFront console → Distributions → ID column. **Not readable from GitHub** — secrets are write-only | **E3I3BUXWGYS0OG** |
| Lambda function name | `VisitorCountFunc` | ✔ |
| GitHub repo | `gchis66/portfolio-site` | ✔ |
| Branch | `main` | ✔ |

**Note on existing identity providers:** this account already has `AWSSSO_6d506f25137a3b66_DO_NOT_DELETE` (type **SAML**), created by IAM Identity Center for console sign-in. It is unrelated to GitHub OIDC — different protocol, different purpose. **Do not delete or modify it.** You need to add a separate provider of type **OpenID Connect**; the two coexist without interacting.

---

## 3. Create the OIDC identity provider in AWS

Once per AWS account. If you've done this before, skip to §4.

1. Console → **IAM** → left nav **Identity providers** → **Add provider**
2. Select **OpenID Connect**
3. **Provider URL:** `https://token.actions.githubusercontent.com`
4. Click **Get thumbprint** (AWS fetches it; you don't need to supply one manually)
5. **Audience:** `sts.amazonaws.com`
6. **Add provider**

Verify it appears as `token.actions.githubusercontent.com`.

**Status: ✔ done (29 Jul 2026)**

---

## 4. Create the IAM policy (least privilege)

IAM → **Policies** → **Create policy** → **JSON** tab. Replace the editor contents with the following, substituting `671175724628` and `E3I3BUXWGYS0OG`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SyncWebsiteObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::gregorychisholm.com/*"
    },
    {
      "Sid": "ListBucketForSync",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::gregorychisholm.com"
    },
    {
      "Sid": "InvalidateCache",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::671175724628:distribution/E3I3BUXWGYS0OG"
    },
    {
      "Sid": "UpdateCounterLambda",
      "Effect": "Allow",
      "Action": "lambda:UpdateFunctionCode",
      "Resource": "arn:aws:lambda:us-east-1:671175724628:function:VisitorCountFunc"
    }
  ]
}
```

Name it: `PortfolioSiteDeployPolicy`

**Note on the ARN shapes** — worth understanding, not just copying:
- `s3:ListBucket` acts on the *bucket* (`...:::bucket`), while object actions act on *objects* (`...:::bucket/*`). Two separate statements; this is the #1 thing people get wrong.
- CloudFront ARNs have **no region** — `arn:aws:cloudfront::ACCOUNT:...` (double colon is correct).
- `--delete` on `aws s3 sync` is why `s3:DeleteObject` is needed.

---

## 5. Create the role

IAM → **Roles** → **Create role**

1. Trusted entity type: **Web identity**
2. **Identity provider:** `token.actions.githubusercontent.com`
3. **Audience:** `sts.amazonaws.com`
4. GitHub organization: `gchis66` · Repository: `portfolio-site` · Branch: `main`
5. Next → attach **`PortfolioSiteDeployPolicy`**
6. Role name: `GitHubActions-PortfolioSite-Deploy`
7. Create role

Then **verify the trust policy** — the console's branch field sometimes produces a looser condition than you want. Open the role → **Trust relationships** → **Edit trust policy**. It must read:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::671175724628:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:gchis66/portfolio-site:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

**Both conditions are mandatory.** Missing `sub` means *any* GitHub repository on the internet can assume your role. Missing `aud` weakens token-confusion protection. If the console generated `StringLike` with a `*`, replace it with the exact `StringEquals` above.

Copy the **Role ARN** from the summary page:
`arn:aws:iam::671175724628:role/GitHubActions-PortfolioSite-Deploy`

### Why one role and not two

Both workflows run from the same repo and branch, so their trust conditions would be identical — anyone who can push to `main` can trigger either one. Splitting into two roles wouldn't reduce the realistic blast radius, only add moving parts. One role, four scoped statements. (If you later add a workflow for a *different* branch or environment, that gets its own role with its own `sub` condition.)

---

## 6. Update the workflow

### ⚠️ Which file — read this first

The repo contains **three** workflow-looking files. Only one of them runs:

| File | Runs? |
|---|---|
| `.github/workflows/deploy-website.yml` | ✅ **YES** — this is the live pipeline |
| `deploy-website.yml` (repo root) | ❌ No — dead leftover, GitHub ignores it |
| `deploy-lambda.yml` (repo root) | ❌ No — dead leftover, GitHub ignores it |

GitHub Actions **only** executes workflows located in `.github/workflows/`. Files in the repo root are inert regardless of their contents.

The live file is **one workflow with two jobs** (`deploy-website` and `deploy-lambda`), so there are **two** `Configure AWS Credentials` steps to convert. The Lambda job detects changes with `git diff HEAD~1 HEAD` rather than a `paths:` trigger, which is why it needs `fetch-depth: 2`.

**Also delete the two root-level files** in this same commit. Leaving stale copies containing `secrets.AWS_ACCESS_KEY_ID` next to a hardened pipeline is misleading to anyone reviewing the repo — including you in six months, and including a hiring manager who clones it.

### The file: `.github/workflows/deploy-website.yml`

Already written to disk. Full contents:

```yaml
name: Deploy Website and Lambda
on:
  push:
    branches: [ main ]

permissions:
  id-token: write      # REQUIRED — lets the runner request the OIDC JWT
  contents: read       # REQUIRED — for actions/checkout

jobs:
  deploy-website:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::671175724628:role/GitHubActions-PortfolioSite-Deploy
          role-session-name: gha-deploy-website
          aws-region: us-east-1

      - name: Sync to S3
        run: aws s3 sync --delete ./prod s3://gregorychisholm.com

      - name: Invalidate CloudFront Cache
        run: aws cloudfront create-invalidation --distribution-id ${{ secrets.DISTRIBUTION_ID }} --paths "/*"

  deploy-lambda:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Needed to check for file changes

      - name: Check for Lambda changes
        id: lambda-changes
        run: |
          if git diff --name-only HEAD~1 HEAD | grep -q "^lambda/"; then
            echo "changed=true" >> $GITHUB_OUTPUT
          else
            echo "changed=false" >> $GITHUB_OUTPUT
          fi

      - name: Configure AWS Credentials
        if: steps.lambda-changes.outputs.changed == 'true'
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::671175724628:role/GitHubActions-PortfolioSite-Deploy
          role-session-name: gha-deploy-lambda
          aws-region: us-east-1

      - name: Zip Lambda code
        if: steps.lambda-changes.outputs.changed == 'true'
        run: |
          cd lambda
          zip -r function.zip . -x "*.git*"

      - name: Update Lambda Function
        if: steps.lambda-changes.outputs.changed == 'true'
        run: aws lambda update-function-code --function-name VisitorCountFunc --zip-file fileb://lambda/function.zip
```

### What changed

1. **Added the `permissions:` block** at workflow level. Without `id-token: write` the runner cannot request an OIDC token and the credentials step fails. This is the single most common OIDC setup mistake. Declared once at the top so it covers both jobs.
2. **Both** `Configure AWS Credentials` steps: the three lines `aws-access-key-id` / `aws-secret-access-key` / `aws-region: ${{ secrets.AWS_REGION }}` are replaced by `role-to-assume` + `role-session-name` + a literal `aws-region: us-east-1`.
3. **Distinct `role-session-name` per job** (`gha-deploy-website` / `gha-deploy-lambda`). This is what appears in CloudTrail, so you can tell which job did what.
4. Region is now inline rather than a secret. A region name isn't sensitive, and inlining makes the workflow self-documenting.

`DISTRIBUTION_ID` remains a secret and is still referenced — do not delete that one.

### Optional cleanup

The distribution ID (`E3I3BUXWGYS0OG`) isn't sensitive — it's discoverable from a DNS lookup of the site. You could inline it and drop the `DISTRIBUTION_ID` secret entirely, leaving zero write-only secrets in the repo. Your call.

## 7. Test

1. Commit and push both workflow changes to `main`.
2. GitHub → **Actions** → watch *Deploy Website to S3*.
3. Confirm the **Configure AWS Credentials** step succeeds (it will log an assumed-role ARN, not an IAM user).
4. Confirm sync + invalidation succeed.
5. Load gregorychisholm.com, hard-refresh, confirm the site and the **view counter** still work.

Only after the website workflow is green, test the Lambda path: make a trivial change under `lambda/` (a comment) and push. Confirm the counter still increments afterward.

---

## 8. Clean up — this is the part that delivers the benefit

Nothing is actually more secure until the old credentials are gone.

1. **GitHub** → repo → Settings → Secrets and variables → Actions → delete:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` (no longer referenced)
   - **Keep** `DISTRIBUTION_ID`
2. **AWS** → IAM → Users → find the deploy user → **Security credentials** → set its access key to **Inactive**
3. Re-run the website workflow. It must still pass (proves nothing depended on the old key).
4. Wait a day or two, then **delete** the access key and, if the user has no other purpose, delete the IAM user.

Deactivate-then-delete rather than deleting immediately: if something did quietly depend on that key, reactivating is instant, whereas a deleted key is unrecoverable.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `Credentials could not be loaded` / no OIDC token | Missing `permissions: id-token: write` |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` in trust policy doesn't match exactly. Must be `repo:gchis66/portfolio-site:ref:refs/heads/main`. Check for typos, wrong branch, trailing whitespace |
| `InvalidIdentityToken` | Audience mismatch — provider and trust policy must both be `sts.amazonaws.com` |
| `AccessDenied` on `s3 sync` | Missing the separate `s3:ListBucket` statement on the bucket ARN (without `/*`) |
| `AccessDenied` on invalidation | CloudFront ARN needs the empty region segment: `arn:aws:cloudfront::ACCOUNT:distribution/ID` |
| Works on `main`, fails on a PR branch | Correct and intended. Trust policy is branch-scoped |

---

## 10. Follow-on work (same session, cheap)

- **CloudFront security headers** — response headers policy with CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Then screenshot an A from securityheaders.com for the site. (positioning-updates.md §2.4)
- **Blog post #1 of 2026** — "Removing static AWS credentials from my CI pipeline." You'll have the before/after, the trust policy, the least-privilege JSON, and the CloudTrail evidence. Fixes the dead blog and produces a résumé bullet from work you already did.
