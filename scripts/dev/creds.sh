# 用法：. scripts/dev/creds.sh   → 匯出 GB_ACC / GB_PW（從 gitignored 的 .credentials.local.md 讀，不會印出）
CF="${GB_CRED_FILE:-/Users/aimand/.gemini/File/groupbuy/.credentials.local.md}"
export GB_ACC=$(grep '後台帳號' "$CF" | awk -F'|' '{print $3}' | xargs)
export GB_PW=$(grep '後台密碼' "$CF" | awk -F'|' '{print $3}' | xargs)
