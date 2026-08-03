# RUNBOOK — Replace long-lived AWS keys with GitHub OIDC

**Target:** `gchis66/portfolio-site` → AWS account (us-east-1)
**Removes:** `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` GitHub secrets + the IAM user behind them
**Time:** ~45 min
**Prereq:** ⚠️ Commit the real `lambda/index.js` first — see §0

---

## 0. PREREQ — do not skip

`lambda/index.js` in the repo is **0 bytes**, but `VisitorCountFunc` works in production. The real code exists only in AWS.

`deploy-lambda.yml` fires on any push touching `lambda/**` and runs `aws lambda update-function-code`. If it fires with an empty `index.js`, the view counter breaks.

1. AWS Console → Lambda → `VisitorCountFunc`
2. **Actions → Export function → Download deployment package**
3. Unzip, copy the real source into `PortfolioSite/lambda/`
4. Commit it (this push touches `lambda/**`, so the old workflow will run and redeploy identical code — harmless, and it proves the pipeline still works before you change auth)

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
| AWS Account ID | Console top-right account menu (12 digits) | `____________` |
| Region | `us-east-1` (matches your API Gateway URL) | `us-east-1` |
| S3 bucket | `gregorychisholm.com` | ✔ |
| CloudFront distribution ID | GitHub → repo → Settings → Secrets → `DISTRIBUTION_ID`, or CloudFront console | `____________` |
| Lambda function name | `VisitorCountFunc` | ✔ |
| GitHub repo | `gchis66/portfolio-site` | ✔ |
| Branch | `main` | ✔ |

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

---

## 4. Create the IAM policy (least privilege)

IAM → **Policies** → **Create policy** → **JSON** tab. Replace the editor contents with the following, substituting `YOUR_ACCOUNT_ID` and `YOUR_DISTRIBUTION_ID`:

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
      "Resource": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
    },
    {
      "Sid": "UpdateCounterLambda",
      "Effect": "Allow",
      "Action": "lambda:UpdateFunctionCode",
      "Resource": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:VisitorCountFunc"
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
        "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
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
`arn:aws:iam::YOUR_ACCOUNT_ID:role/GitHubActions-PortfolioSite-Deploy`

### Why one role and not two

Both workflows run from the same repo and branch, so their trust conditions would be identical — anyone who can push to `main` can trigger either one. Splitting into two roles wouldn't reduce the realistic blast radius, only add moving parts. One role, four scoped statements. (If you later add a workflow for a *different* branch or environment, that gets its own role with its own `sub` condition.)

---

## 6. Update the workflows

### `deploy-website.yml`

```yaml
name: Deploy Website to S3
on:
  push:
    branches: [ main ]

permissions:
  id-token: write      # REQUIRED — lets the runner request the OIDC JWT
  contents: read       # REQUIRED — for actions/checkout

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::YOUR_ACCOUNT_ID:role/GitHubActions-PortfolioSite-Deploy
          role-session-name: gha-deploy-website
          aws-region: us-east-1

      - name: Sync to S3
        run: aws s3 sync --delete ./prod s3://gregorychisholm.com

      - name: Invalidate CloudFront Cache
        run: aws cloudfront create-invalidation --distribution-id ${{ secrets.DISTRIBUTION_ID }} --paths "/*"
```

### `deploy-lambda.yml`

```yaml
name: Deploy Lambda Function
on:
  push:
    branches: [ main ]
    paths:
      - 'lambda/**'

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::YOUR_ACCOUNT_ID:role/GitHubActions-PortfolioSite-Deploy
          role-session-name: gha-deploy-lambda
          aws-region: us-east-1

      - name: Zip Lambda code
        run: |
          cd lambda
          zip -r function.zip . -x "*.git*"

      - name: Update Lambda Function
        run: aws lambda update-function-code --function-name VisitorCountFunc --zip-file fileb://lambda/function.zip
```

**Changes:** the three `aws-access-key-id` / `aws-secret-access-key` / `aws-region: ${{ secrets.AWS_REGION }}` lines are replaced by `role-to-assume` + `role-session-name` + a literal region. The `permissions:` block is new and **the workflow fails without it** — this is the most common OIDC setup mistake.

Region is now hardcoded rather than a secret. A region name isn't sensitive and having it inline makes the workflow self-documenting.

`role-session-name` is what shows up in CloudTrail. Different values per workflow means you can tell which pipeline did what.

---

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
