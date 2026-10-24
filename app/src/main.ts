import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { installBackHandler } from '@/lib/back'
import { loadTheme } from '@/lib/themes'
import './styles.css'

// Android 返回键 / 侧滑返回：有上一页则回退，根页面才退出 App
installBackHandler(router)

// 恢复上次选择的主题（挂载前调用，避免首帧闪回默认主题）
loadTheme()

createApp(App).use(router).mount('#app')
