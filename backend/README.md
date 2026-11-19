# NPU 资源看板

四台共享服务器的实时状态和用卡登记。团队名称由登记人填写。登记到期后自动释放，提交登记的浏览器可提前释放或延长时间。可登记单卡、多卡或整机。登记用于协调使用。

## 构建与测试

需要 Node.js 22 和 Python 3。

```sh
npm run build
npm test
python3 tests/collector_test.py
```

前端只有一份，即仓库根目录的 `index.html`。GitHub Pages 直接发布它，`npm run build` 也会把它打包进 Worker 供 Sites 在 `/` 提供。页面内联样式和脚本，修改后须重新计算 `<meta http-equiv="Content-Security-Policy">` 中的两个 sha256 哈希。

`dist/server/index.js` 是 Sites 的 Worker 入口。数据库绑定为 `DB`，SQL 迁移在 `drizzle/` 下。每台机器在 Sites 的环境变量中使用独立的 `COLLECTOR_TOKEN_1` 至 `COLLECTOR_TOKEN_4`。公开接口 `GET /api/board` 只返回机器 IP、指标和团队登记，机器编号 1 至 4 依次对应 `worker.mjs` 中 `MACHINE_HOSTS` 的四个 IP。

## 服务器采集

采集脚本只读取主机指标和昇腾设备指标。每台机器的 `/etc/npu-board/collector.env` 中设置 `NPU_BOARD_ENDPOINT` 和 `NPU_BOARD_TOKEN`。上报地址以 `/api/ingest/1` 到 `/api/ingest/4` 结尾。主机配置目录和凭据文件分别使用 0700 和 0600 权限。

采集脚本位于 `/opt/npu-board/collect.py`。用 `systemctl status npu-board-collect.timer` 检查定时器，用 `journalctl -u npu-board-collect.service` 检查上报日志。运行 `python3 /opt/npu-board/collect.py --sample` 可在本机查看一次脱敏采样。

登记时需要提供工号，看板公开显示完整工号。`0003_employee.sql` 之前的登记只保存了末四位，早期登记可以没有工号。

## 遥测中转

直传不可达时，可在一台机器运行 `collector/relay.py` 和 `npu-board-relay.service`。中转与站点使用同一组独立的 `RELAY_TOKEN_1` 至 `RELAY_TOKEN_4` 机密值。中转服务的环境文件用 `COLLECTOR_TOKEN_1` 至 `COLLECTOR_TOKEN_4` 对应同一组密钥。站点用 `COLLECTOR_RELAY_URL` 读取 `/v1/metrics`。采集端设 `NPU_BOARD_TRANSPORT=relay`，将上报地址指向中转的 `/api/ingest/<机器编号>`。中转链路只传已准许公开的指标。每份快照会独立签名，密钥不随快照传输。

## Mac 中转与 GitHub Pages

站点前端发布在 [GitHub Pages](https://huangzjun.github.io/Npu_Machine/)，由 Sites API 处理占用登记。Mac 的 `local.npu-board.mac-relay` 用户 LaunchAgent 每 30 秒通过受限 SSH 读取四台机器的脱敏样本并推送到 Sites。Mac 休眠、退出登录或断网期间，后台采集会暂停。

Mac 采集程序使用 `collector/mac/relay.mjs`。各服务器通过缓存定时器生成样本，专用 SSH 账号仅运行 `collector/mac/read_sample.py`。
