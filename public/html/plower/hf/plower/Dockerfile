FROM ollama/ollama:latest

# Hugging Face Spacesの推奨設定 (UID 1000)
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH
WORKDIR $HOME

# 権限設定のために一時的にrootユーザーへ切り替え
USER root

# モデル保存用ディレクトリを作成し、権限をUID 1000に設定
# これにより "permission denied" エラーを防ぎます
RUN mkdir -p $HOME/.ollama/models && \
    chown -R 1000:1000 $HOME

# 起動スクリプトをコピーして実行権限を付与
COPY start.sh .
RUN chmod +x start.sh && \
    chown 1000:1000 start.sh

# 環境変数の設定
# ポート7860はHugging Face Spacesの要件
ENV OLLAMA_HOST=0.0.0.0:7860
ENV OLLAMA_ORIGINS="https://sagbuntu.web.app,http://localhost:*,http://127.0.0.1:*"
ENV OLLAMA_MODELS=$HOME/.ollama/models

# 実行ユーザーをUID 1000に切り替え
USER 1000

# モデルのプリインストール (タイムアウト回避のため Gemma 2 2B に変更)
RUN (ollama serve &) && sleep 10 && ollama pull gemma2:2b

# 【重要】ベースイメージのENTRYPOINT（ollamaコマンドの自動実行）を無効化します
ENTRYPOINT []

# シェルスクリプトを起動コマンドとして指定
CMD ["./start.sh"]
