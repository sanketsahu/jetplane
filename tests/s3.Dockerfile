# S3 of the local-first pyramid: the orchd-style PREBUILT image, reproduced on the
# host. Build context = the jetplane REPO ROOT (so the local checkout, not the npm
# release, is what gets baked and served):
#
#   docker build -f tests/s3.Dockerfile -t jp-s3:test .
#
# Mirrors the production template build (website tools/project-templates/*/scaffold/
# orchd.json): bake the scaffold WITHOUT the AI screens, with sentinel env values,
# under HOME=/cache. The runtime wrapper (tests/image.mjs) then bind-mounts the full
# fixture over /app and seds real env values in — exactly orchd's volume-run.
FROM node:20-slim
ENV HOME=/cache JETPLANE_HOME=/cache EXPO_NO_TELEMETRY=1
RUN apt-get update -qq && apt-get install -y -qq curl unzip procps >/dev/null && npm i -g bun --silent

# the local jetplane checkout (what we are actually testing)
COPY package.json /jetplane/package.json
COPY bin /jetplane/bin
COPY src /jetplane/src

# the project, minus its "AI-generated" screens = the scaffold orchd bakes from
COPY tests/fixtures/router-app /app
WORKDIR /app
RUN rm -rf node_modules && rm -f ".env" ".env."* "app/(app)/index.tsx" "app/(auth)/login.tsx" && rmdir "app/(auth)" 2>/dev/null || true
RUN npm install --legacy-peer-deps --no-audit --no-fund --silent && ln -sfn /jetplane /app/node_modules/jetplane

# bake: run the thin server once with SENTINEL env (Expo inlines EXPO_PUBLIC_* at
# bundle time), wait for /status, stop it, assert the bundles landed in /cache.
RUN EXPO_PUBLIC_SUPABASE_URL=__ORCHD_ENV_SUPABASE_URL__ \
    EXPO_PUBLIC_SUPABASE_ANON_KEY=__ORCHD_ENV_SUPABASE_ANON_KEY__ \
    EXPO_PUBLIC_API_URL=__ORCHD_ENV_API_URL__ \
    EXPO_PUBLIC_RAPIDNATIVE_MODE=staging \
    sh -c 'node /jetplane/bin/jetplane.mjs serve --port 8090 & JP=$!; ok=0; \
      for i in $(seq 1 120); do curl -sf localhost:8090/status >/dev/null 2>&1 && { ok=1; break; }; kill -0 $JP 2>/dev/null || break; sleep 5; done; \
      kill $JP 2>/dev/null; wait $JP 2>/dev/null; [ $ok = 1 ]' \
    && ls /cache/.jetplane/images/*/main.ios.bundle /cache/.jetplane/images/*/files.json

# run wrapper — the orchd manifest's run step, verbatim in spirit: per-boot copy of
# the baked images into JETPLANE_HOME on the data volume, sed the sentinels to the
# real (runtime) env, then exec the thin server.
CMD ["sh","-lc","export JETPLANE_HOME=/data/.cache; export HOME=/data/.cache; mkdir -p $HOME/.jetplane/images; [ -e $HOME/.jetplane/tstore ] || ln -s /cache/.jetplane/tstore $HOME/.jetplane/tstore 2>/dev/null; for d in /cache/.jetplane/images/*/; do n=$(basename $d); t=$HOME/.jetplane/images/$n; if [ ! -e $t ]; then cp -r $d $t; for f in $t/main.*.bundle $t/index.html; do [ -f $f ] || continue; sed -i \"s|__ORCHD_ENV_SUPABASE_URL__|$EXPO_PUBLIC_SUPABASE_URL|g; s|__ORCHD_ENV_SUPABASE_ANON_KEY__|$EXPO_PUBLIC_SUPABASE_ANON_KEY|g; s|__ORCHD_ENV_API_URL__|$EXPO_PUBLIC_API_URL|g\" $f; done; fi; done; exec node /jetplane/bin/jetplane.mjs serve --port ${PORT:-8135}"]
