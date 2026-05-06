# 1. まずは手動で一度デプロイして確認
firebase deploy

# 2. 設定ファイルを Git に記録
git add .
git commit -m "Set up Firebase Hosting and GitHub Actions"

# 3. GitHub にプッシュ（これで次回から自動デプロイが走ります）
git push origin main

