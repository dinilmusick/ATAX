#!/usr/bin/env python3
"""Create a permanent repository from an owner-controlled public/private source."""
import argparse,json,os,re,subprocess,tempfile,shutil,time
from urllib import request,error

API="https://api.github.com"
IDENT=re.compile(r"^[A-Za-z0-9_.-]+$")

def api(path,token,method="GET",payload=None):
    body=None if payload is None else json.dumps(payload).encode()
    req=request.Request(API+path,data=body,method=method,headers={
        "Authorization":"Bearer "+token,"Accept":"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28","User-Agent":"atax-repository-generator"})
    try:
        with request.urlopen(req,timeout=30) as res:
            return json.load(res) if res.status!=204 else {}
    except error.HTTPError as exc:
        raise RuntimeError(f"GitHub {method} {path}: HTTP {exc.code}") from None

def safe_repo(v):
    if not IDENT.fullmatch(v): raise SystemExit("Invalid repository identifier")
    return v

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--template",required=True,help="Source owner/repo; must be public unless destination is private")
    p.add_argument("--owner",required=True)
    p.add_argument("--name",required=True)
    p.add_argument("--visibility",choices=["private","public"],default="private")
    p.add_argument("--description",default="")
    p.add_argument("--ci-workflow",action="store_true")
    a=p.parse_args()
    parts=a.template.split("/")
    if len(parts)!=2 or not all(IDENT.fullmatch(x) for x in parts): p.error("Invalid source repository")
    safe_repo(a.owner); safe_repo(a.name)
    token=os.environ.get("CODING_REPO_TOKEN") or os.environ.get("GH_TOKEN")
    if not token: raise SystemExit("Missing CODING_REPO_TOKEN or GH_TOKEN")
    source=api(f"/repos/{a.template}",token)
    source_private=bool(source.get("private"))
    # Explicit public-portfolio opt-in: a source repository must contain the sentinel.
    public_opt_in=False
    try:
        sentinel=api(f"/repos/{a.template}/contents/.portfolio-public",token)
        public_opt_in=bool(isinstance(sentinel,dict) and sentinel.get("type")=="file")
    except RuntimeError as exc:
        if "HTTP 404" not in str(exc): raise
    if source_private and (a.visibility=="public" or public_opt_in):
        raise SystemExit("SECURITY: private source may not generate a public repository")
    if public_opt_in and not source_private:
        a.visibility="public"
        a.ci_workflow=True
    target=f"{a.owner}/{a.name}"
    try:
        api(f"/repos/{target}",token)
    except RuntimeError as exc:
        if "HTTP 404" not in str(exc): raise
    else:
        raise SystemExit("Destination already exists; refusing to overwrite")

    created=api("/user/repos",token,"POST",{
        "name":a.name,"private":a.visibility=="private",
        "description":a.description,"auto_init":False})
    if str(created.get("full_name","")).lower()!=target.lower():
        raise SystemExit("Unexpected generated repository identity")
    source_url=f"https://github.com/{a.template}.git"
    target_url=f"https://github.com/{target}.git"
    with tempfile.TemporaryDirectory(prefix="atax-repo-copy-") as work:
        src=os.path.join(work,"src")
        subprocess.run(["git","clone","--depth","1",source_url,src],check=True,capture_output=True,text=True)
        git_dir=os.path.join(src,".git")
        if os.path.exists(git_dir): shutil.rmtree(git_dir)
        if a.ci_workflow:
            wf=os.path.join(src,".github","workflows")
            os.makedirs(wf,exist_ok=True)
            with open(os.path.join(wf,"ci.yml"),"w",encoding="utf-8") as f:
                f.write("""name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run check
""")
        subprocess.run(["git","-C",src,"init","-b","main"],check=True,capture_output=True,text=True)
        subprocess.run(["git","-C",src,"config","user.name","github-actions[bot]"],check=True)
        subprocess.run(["git","-C",src,"config","user.email","41898282+github-actions[bot]@users.noreply.github.com"],check=True)
        subprocess.run(["git","-C",src,"add","."],check=True)
        subprocess.run(["git","-C",src,"commit","-m","feat: initialize portfolio application"],check=True,capture_output=True,text=True)
        auth_header="AUTHORIZATION: basic "+subprocess.check_output(
            ["bash","-lc","printf 'x-access-token:%s' "$CODING_REPO_TOKEN" | base64 -w0"],
            env={**os.environ,"CODING_REPO_TOKEN":token},text=True).strip()
        subprocess.run(["git","-C",src,"-c",f"http.extraheader={auth_header}","remote","add","origin",target_url],check=True)
        subprocess.run(["git","-C",src,"-c",f"http.extraheader={auth_header}","push","origin","main"],check=True,capture_output=True,text=True)

    for _ in range(20):
        target_info=api(f"/repos/{target}",token)
        if bool(target_info.get("private"))==(a.visibility=="private") and target_info.get("default_branch"):
            branch=api(f"/repos/{target}/branches/{target_info['default_branch']}",token)
            sha=branch.get("commit",{}).get("sha")
            if sha:
                print(json.dumps({"repository":target,"url":target_info["html_url"],"visibility":a.visibility,"commit":sha,"source":a.template}))
                return
        time.sleep(2)
    raise SystemExit("Repository created but final branch was not verified")

if __name__=="__main__":
    main()
