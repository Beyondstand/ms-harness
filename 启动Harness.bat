@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo 首次运行：安装依赖（约 100MB，国内网络若超时可先执行 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ^&^& npm install^）
  call npm install
)
call node_modules\.bin\electron.cmd .
