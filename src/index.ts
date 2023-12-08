import {
  Plugin,
  fetchPost,
  fetchSyncPost,
  openTab,
  Setting,
  openMobileFileById,
  getFrontend
} from "siyuan";
import "@/index.scss";
import { Md5 } from "ts-md5";
import TurndownService from 'turndown';
import moment from "moment";

let onSyncEndEvent: EventListener;
const STORAGE_NAME = "flomo-sync-config";
const FLOMO_ASSETS_DIR = "/assets/flomo";
const USG = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.76";


export default class FlomoSync extends Plugin {
  private isMobile: boolean;
  private siyuanStorage;
  private syncing: boolean = false;
  async pushMsg(msg) {
    fetchPost("/api/notification/pushMsg", { msg: msg });
  }

  async pushErrMsg(msg) {
    fetchPost("/api/notification/pushErrMsg", { msg: msg });
  }

  async getLocalStorage() {
    return await fetchSyncPost("/api/storage/getLocalStorage");
  }

  /**
   * 获取所有记录：上次同步时间作为起点
   */
  async getLatestMemos() {
    let allRecords = [];
    let syncSuccessTag = this.data[STORAGE_NAME]["syncSuccessTag"]
    let lastSyncTime = this.data[STORAGE_NAME]["lastSyncTime"]

    const limit = 200;
    let today = new Date();
    //只能是指定时间或今天00:00:00
    let latest_updated = moment(lastSyncTime, 'YYYY-MM-DD HH:mm:ss').toDate()
      || moment(today, 'YYYY-MM-DD 00:00:00').toDate()
    let latest_updated_at_timestamp;

    while (true) {
      try {
        latest_updated_at_timestamp = (Math.floor(latest_updated.getTime()) / 1000).toString();
        let latest_slug = ""
        let ts = Math.floor(Date.now() / 1000).toString();
        let signString = `api_key=flomo_web&app_version=2.0&latest_updated_at=${latest_updated_at_timestamp}&limit=${limit}&timestamp=${ts}&tz=8:0&webp=1dbbc3dd73364b4084c3a69346e0ce2b2`
        let sign = new Md5().appendStr(signString).end();
        let url = "https://flomoapp.com/api/v1/memo/updated/?limit=" + limit + "&latest_updated_at=" + latest_updated_at_timestamp + "&latest_slug=" + latest_slug + "&tz=8:0&timestamp=" +
          ts + "&api_key=flomo_web&app_version=2.0&webp=1&sign=" + sign;

        let response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.data[STORAGE_NAME]["accessToken"]}`,
            'Content-Type': 'application/json',
            'User-Agent': USG
          },
          // credentials: 'include',
          // mode: "cors",
        })
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (this.check_authorization_and_reconnect(data)) {
          // console.log(data);
          let records = data["data"];
          let noMore = records.length < limit;
          if (records.length == 0) {
            break
          }
          latest_updated = moment(records[records.length - 1]["updated_at"], 'YYYY-MM-DD HH:mm:ss').toDate()
          //过滤已删除的（回收站的）,过滤包含同步标识的
          allRecords = allRecords.concat(records.filter(record => {
            // console.log(record);
            return !record["deleted_at"] && !record["tags"].includes(syncSuccessTag);
          }));

          if (noMore) { //没有更多了
            break
          }
        } else {
          throw new Error(`flomo登录校验失败`);
        }

      } catch (error) {
        await this.pushErrMsg("plugin-flomo-sync:" + "请检查错误：" + error)
        throw new Error(`${error}`);
      }
    }

    return allRecords;
  }


  /**
   * 开始同步
   */
  async runSync() {
    // 防止快速点击、或手动和自动运行冲突。
    if (this.syncing == true) {
      // console.log("plugin-flomo-sync:" + "正在同步，请稍后")
      return;
    }

    this.syncing = true;
    try {
      await this.initData();
      let memos = await this.getLatestMemos();
      // console.log(memos);      
      if (memos.length == 0) {
        let nowTimeText = moment().format('YYYY-MM-DD HH:mm:ss');
        console.warn("plugin-flomo-sync:" + "暂无新数据-" + nowTimeText)
        this.syncing = false;
        return;
      }

      //生成markdown 和图片
      let { blockContent, imgs } = this.handleMarkdown(memos)

      // 处理图片：下载图片到思源
      let handleImgSuccess = await this.downloadImgs(imgs)

      // 处理内容：写入思源
      let handleContentSuccess;
      if (handleImgSuccess) {
        // console.log(blockContent)
        handleContentSuccess = await this.writeSiyuan(blockContent);
      }

      // 回写标签    
      if (handleContentSuccess && handleImgSuccess) {
        await this.writeBackTag(memos);
      }

      // 记录同步时间,间隔1秒
      await setTimeout(async () => {
        // console.log("记录同步时间：");
        let nowTimeText = moment().format('YYYY-MM-DD HH:mm:ss');
        // console.log(nowTimeText);
        this.data[STORAGE_NAME]["lastSyncTime"] = nowTimeText;
        await this.saveData(STORAGE_NAME, this.data[STORAGE_NAME]);
      }, 1000)
    } catch (error) {
      throw new Error(error)
      // this.syncing = false;
    } finally{
      this.syncing = false;
    }
    
  }


  /**把内容写进今日日记中 */
  async writeSiyuan(blockContent: string) {
    //日记库id
    let notebook = this.siyuanStorage["local-dailynoteid"]
    //获取今日文档id
    let todayId = await this.getTodayId(notebook);

    let url = "/api/block/appendBlock"
    let data = {
      "data": blockContent,
      "dataType": "markdown",
      "parentID": todayId
    }

    let rs = await fetchSyncPost(url, data);
    if (rs.code != 0) {
      console.log("plugin-flomo-sync:" + rs.msg);
    }
    //写入后打开今日页面
    if(this.isMobile){
      openMobileFileById(this.app, todayId)
    }else{
      openTab({ app: this.app, doc: { id: todayId } });
    }

    return rs.code == 0;
  }

  /**
   * 获取今日id
   * @param notebook 笔记本id
   * @returns 
   */
  async getTodayId(notebook) {
    let response = await fetchSyncPost("/api/filetree/createDailyNote", { notebook: notebook })
    return response["data"]["id"];
  }


  /**根据待同步的内容，生成markdown */
  handleMarkdown(memos) {
    let blockContent = '';
    let imgs = [];

    memos.every(memo => {
      let content = memo.content;
      let files = memo.files;
      // 图片markdown
      imgs = imgs.concat(files);
      files.forEach(img => {
        let imgName = img["name"];
        if (!(imgName.endsWith(".png") || imgName.endsWith(".png") || imgName.endsWith(".gif"))) {
          imgName = imgName + '.png'
        }
        let imgMd = "![" + img["name"] + "](" + FLOMO_ASSETS_DIR + "/" + img["id"] + "_" + imgName + ") ";
        // console.log(imgMd)
        content += imgMd
      })
      content = content.trim()
      content = new TurndownService().turndown(content);
      content = content.replaceAll('\\\[', '[').replaceAll('\\\]', ']').replaceAll('\\\_', '_').replaceAll(/(?<=#)(.+?)(?=\s)/g, "$1#");
      content = content.split("\n").reduce((result, line) => {
        if (line.trim() == "") {
          line = ""
        }
        return result + "\t" + line + "\n"
      }, "")

      blockContent += '*  \n' + content;
      return true;
    })

    blockContent = blockContent.replace(/\n*$/g, "").replace(/^\n*/g, "")
    return { blockContent, imgs }
  }


  /**
   * 
   * @param imgs 下载图片到思源
   */
  async downloadImgs(imgs) {
    // 处理图片逻辑
    try {
      imgs.every(async img => {
        let imgName = img["name"];
        if (!(imgName.endsWith(".png") || imgName.endsWith(".png") || imgName.endsWith(".gif"))) {
          imgName = imgName + '.png'
        }

        let imgPath = "data/" + FLOMO_ASSETS_DIR + "/" + img["id"] + "_" + imgName;
        let imgRespon = await fetch(img["url"]);
        let fileBlob = await imgRespon.blob();
        // console.log(fileBlob);
        // console.log(imgPath);
        await this.addFile(imgPath, fileBlob);
        return true
      })
    } catch (error) {
      await this.pushErrMsg("plugin-flomo-sync:" + error)
      return false;
    }
    return true;
  }

  async addFile(f, file) {
    const fd = new FormData();
    fd.append('path', f);
    fd.append('isDir', 'false');
    fd.append('file', file);
    return await fetch('/api/file/putFile', {
      method: 'POST',
      body: fd
    });
  }

  /**
   * 
   * @param memos 回写标签到flomo：标识已同步
   * @param syncSuccessTag 
   */
  async writeBackTag(memos: any[]) {
    let syncSuccessTag = this.data[STORAGE_NAME]["syncSuccessTag"]
    if (!syncSuccessTag) {
      return
    }

    let config = this.data[STORAGE_NAME];
    let baseUrl = "https://flomoapp.com/api/v1/memo"
    memos.every(async memo => {
      let nowTime = Date.now();
      let timestamp = Math.floor(nowTime / 1000).toFixed();
      // console.log("最后回写标签时间");
      // console.log(new Date(nowTime));
      let url = baseUrl + "/" + memo["slug"];
      let sign = this.createSign(config.username, config.password, timestamp);
      let addTag1 = "<p>#已同步 "
      let addTag2 = "<p>#已同步 </p>"
      let content = memo["content"].includes("<p>") ?
        memo["content"].replace("<p>", addTag1) :
        addTag2.concat(memo["content"])
      let file_ids = memo["files"].map(file => file.id);
      let data = {
        api_key: "flomo_web",
        app_version: "2.0",
        content: content,
        created: memo["created"],
        file_ids: file_ids,
        local_updated_at: timestamp,
        platform: "web",
        sign: sign,
        timestamp: timestamp,
        tz: "8:0",
        webp: "1"
      }

      let response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.data[STORAGE_NAME]["accessToken"]}`,
          'Content-Type': 'application/json',
          'User-Agent': USG
        },
        // credentials: 'include',
        body: JSON.stringify(data)
        // mode: "cors",
      })
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const resPon = await response.json();
      // debugger;
      if (this.check_authorization_and_reconnect(resPon)) {
        // console.log(resPon);
      }
      // 处理逻辑：间隔1秒发请求，防止太快
      setTimeout(() => { }, 1000)
    })
  }

  /**
   * 处理监听同步事件
   * @param detail 
   */
  async eventBusHandler(detail) {
    await this.runSync();
  }


  // 默认数据
  async initData() {
    this.data[STORAGE_NAME] = await this.loadData(STORAGE_NAME);
    if (JSON.stringify(this.data[STORAGE_NAME]) === "{}") {
      this.data[STORAGE_NAME] = {
        username: "",//用户名
        password: "",//密码
        lastSyncTime: "",//上次同步时间
        syncSuccessTag: "",//同步成功标签
        isAutoSync: false,//是否绑定思源的同步
        accessToken: "",//accessToken
      }
    }
  }


  async onload() {
    // 加载配置数据
    await this.initData();
    const frontEnd = getFrontend();
    this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";
    onSyncEndEvent = this.eventBusHandler.bind(this);
    if(this.data[STORAGE_NAME].isAutoSync){
      this.eventBus.on("sync-end", onSyncEndEvent);
    }
    let conResponse = await this.getLocalStorage();
    this.siyuanStorage = conResponse["data"];
    // console.log(this.siyuanStorage);
    const topBarElement = this.addTopBar({
      icon: '<svg t="1701609878223" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="4530" width="200" height="200"><path d="M0 0h1024v1024H0z" fill="#FAFAFA" p-id="4531"></path><path d="M709.461 507.212H332.07V399.559h447.497l-65.422 105.264c0 2.389-2.342 2.389-4.684 2.389z m98.143-167.462H450.067l65.441-105.273c2.342 0 4.675-2.39 7.016-2.39h355.177l-65.422 105.264c0 2.399-2.342 2.399-4.684 2.399z" fill="#30CF79" p-id="4532"></path><path d="M337.91 791.912c-105.159 0-191.62-88.519-191.62-196.181s86.461-196.172 191.62-196.172c105.15 0 191.621 88.51 191.621 196.172s-86.47 196.172-191.62 196.172z m0-282.31c-46.743 0-86.47 38.276-86.47 88.518 0 47.853 37.394 88.529 86.47 88.529 49.067 0 86.462-38.286 86.462-88.529-2.342-50.242-39.727-88.519-86.471-88.519z" fill="#30CF79" p-id="4533"></path></svg>',
      title: "flomo同步",
      position: "right",
      callback: await this.runSync.bind(this),
    });

    const usernameElement = document.createElement("textarea");
    const passwordElement = document.createElement("textarea");
    const isAutoSyncElement = document.createElement('input');
    const lastSyncTimeElement = document.createElement('textarea');
    const syncSuccessTagElement = document.createElement('textarea');
    const accessTokenElement = document.createElement('textarea');

    this.setting = new Setting({
      width: '700px',
      height: '500px',
      confirmCallback: async () => {
        if (isAutoSyncElement.checked != this.data[STORAGE_NAME].isAutoSync) {
          if (isAutoSyncElement.checked) {
            this.eventBus.on("sync-end", this.eventBusHandler);
          } else {
            this.eventBus.off("sync-end", this.eventBusHandler);
          }
        }
        await this.saveData(STORAGE_NAME, {
          username: usernameElement.value,
          password: passwordElement.value,
          isAutoSync: isAutoSyncElement.checked,
          lastSyncTime: lastSyncTimeElement.value,
          syncSuccessTag: syncSuccessTagElement.value,
          accessToken: accessTokenElement.value
        });
      }
    });

    this.setting.addItem({
      title: "账号",
      description: "请输入flomo的手机号或邮箱",
      createActionElement: () => {
        usernameElement.className = "b3-text-field fn__block";
        usernameElement.placeholder = "手机或邮箱";
        usernameElement.value = this.data[STORAGE_NAME].username;
        return usernameElement;
      },
    });


    this.setting.addItem({
      title: "密码",
      createActionElement: () => {
        passwordElement.className = "b3-text-field fn__block";
        passwordElement.placeholder = "请输入密码";
        passwordElement.value = this.data[STORAGE_NAME].password;
        return passwordElement;
      },
    });

    this.setting.addItem({
      title: "是否自动同步",
      description: "思源同步完成后自动同步flomo",
      createActionElement: () => {
        isAutoSyncElement.type = 'checkbox';
        isAutoSyncElement.className = "b3-switch fn__flex-center";
        isAutoSyncElement.checked = this.data[STORAGE_NAME].isAutoSync;
        return isAutoSyncElement;
      },
    });

    let today = moment().format("YYYY-MM-DD 00:00:00");
    this.setting.addItem({
      title: "上次同步时间",
      description: `为空则默认为今天0点，${today}，并会自动记录本次同步时间`,
      createActionElement: () => {
        lastSyncTimeElement.className = "b3-text-field fn__block";
        lastSyncTimeElement.placeholder = "如有特殊要求可指定上次同步时间";
        lastSyncTimeElement.value = this.data[STORAGE_NAME].lastSyncTime;
        return lastSyncTimeElement;
      },
    });


    this.setting.addItem({
      title: "回写同步成功标签",
      description: "将同步的记录，加一个标签标识，为空则不加",
      createActionElement: () => {
        syncSuccessTagElement.className = "b3-text-field fn__block";
        syncSuccessTagElement.placeholder = "请输入回写同步成功标签，如：“已同步” ";
        syncSuccessTagElement.value = this.data[STORAGE_NAME].syncSuccessTag;
        return syncSuccessTagElement;
      },
    });

    this.setting.addItem({
      title: "accessToken",
      description: "一般不填，也不修改，除非登录不起作用时可手动更改",
      createActionElement: () => {
        accessTokenElement.className = "b3-text-field fn__block";
        // accessTokenElement.readOnly = true;
        accessTokenElement.value = this.data[STORAGE_NAME].accessToken;
        return accessTokenElement;
      },
    });

  }

  async onunload() {
    this.eventBus.off("sync-end", this.eventBusHandler);
    this.syncing = false;
  }

  async onLayoutReady() {
    // console.log("onLayoutReady");
    if (!this.data[STORAGE_NAME].accessToken) {
      await this.connect();
    }
  }

  // 连接flomo
  async connect() {
    let config = this.data[STORAGE_NAME];
    if (!config.username || !config.password) {
      await this.pushErrMsg("plugin-flomo-sync:" + "用户名或密码为空，重新配置后再试")
    }
    let timestamp = Math.floor(Date.now() / 1000).toFixed();
    let sign = this.createSign(config.username, config.password, timestamp);
    let url = "https://flomoapp.com/api/v1/user/login_by_email"
    let data = {
      "api_key": "flomo_web",
      "app_version": "2.0",
      "email": config.username,
      "password": config.password,
      "sign": sign,
      "timestamp": timestamp,
      "webp": "1",
    }



    try {
      let response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.data[STORAGE_NAME]["accessToken"]}`,
          'Content-Type': 'application/json',
          'User-Agent': USG
        },
        // credentials: 'include',
        body: JSON.stringify(data)
        // mode: "cors",
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const resData = await response.json();
      // console.log(resData);
      if (resData.code == -10) {
        throw new Error(`同步失败，请重试：${resData.message}`);
      } else if (resData.code == -1) {
        throw new Error(`请检查用户名和密码，或手动更新accessToken后再试`);
      } else if (resData.code !== 0) {
        throw new Error(`Server error! msg: ${resData.message}`);
      } else {
        // 登录成功 ，刷新AccessToken
        this.data[STORAGE_NAME]["accessToken"] = resData.data["access_token"];
        await this.saveData(STORAGE_NAME, this.data[STORAGE_NAME]);
      }
      return true;
    } catch (error) {
      await this.pushErrMsg("plugin-flomo-sync:" + error);
      return false;
    }
  }


  createSign(username, password, timestamp) {
    let words = `api_key=flomo_web&app_version=2.0&email=${username}&password=${password}&timestamp=${timestamp}&webp=1dbbc3dd73364b4084c3a69346e0ce2b2`
    let sign = new Md5().appendStr(words).end();
    // console.log(sign);
    return sign;
  }


  async check_authorization_and_reconnect(resData) {
    // 检测到accessToken失效就提示，就重新登录
    if (resData.code == -10) {
      // 重新登录
      await this.connect();
    } else if (resData.code !== 0) {
      await this.pushErrMsg(`Server error! msg: ${resData.message}`);
      // throw new Error(`Server error! msg: ${resData.message}`);
    }
    return resData.code == 0;
  }
}