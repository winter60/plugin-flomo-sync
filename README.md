# 浮墨同步插件

### 功能介绍
flomo特别时候移动端速记，该插件是将flomo中的memo同步到当前默认笔记库的今日日记中。支持手动同步和自动同步，自动同步是在思源同步完成后自动进行。仅支持单向同步(flomo→siyuan)，同步思源后再次修改flomo不再同步。

### 配置介绍：
1. 先在插件设置中，配置flomo账号和密码（必填）。
2. `是否自动同步`是在思源同步完成后自动进行。
3. `上次同步时间`一般不用填，会自动记录上次同步时间。根据需要，可手动设置为想要同步的起始时间。格式必须按照：`YYYY-MM-DD HH:MM:SS`，如`2023-12-08 12:12:12` 。
4. `回写同步成功标签` 在同步成功后，是否根据需要给flomo的memo用标签加一个同步标识，如：`已同步`，不用写`#`。默认不回写。
5. `accessToken` 不用管这个。

### 特别感谢
参考了[flomo 同步助手 - by mdzz2048 - 动作信息 - Quicker](https://getquicker.net/Sharedaction?code=02ed5443-2dc2-47a1-2ed0-08db2d92bfe7) 
使用了f佬提供的[plugin-sample-vite模板仓库](https://github.com/frostime/plugin-sample-vite)。
还有思源插件开发者里帮我解决问题小伙伴们，vv大佬、折腾群群主、Z佬等等，非常感谢你们

### 其他想说
本插件是因为自己需要移动端速记功能，按照自己的喜好开发，简单就好，如有特别个性话的要求，可能不适合你。有反馈、建议或好的想法可以去仓库[仓库](https://github.com/winter60/plugin-flomo-sync)提issue，我看根据是否适合自己来改。如果想[请我喝咖啡](https://afdian.net/a/firework)，非常感谢！

### 免责声明
该插件仅供用户交流学习，如果有侵犯flomo权益，请联系`ali60@qq.com`从集市下架和删除相关仓库。