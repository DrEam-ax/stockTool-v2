<script setup lang="ts">
/**
 * 单条「截图识别结果」的核对卡片。
 *
 * 为什么单独抽出来：
 *   1. MemoryView 已经很长了，这块是独立职责（核对 + 编辑一条识别结果）
 *   2. **为了能测**。这个卡片踩过两个真实的坑，只有把它独立出来
 *      才能真正 mount 起来做 DOM 断言：
 *        · `<label class="check">` 里套了一堆输入框 —— HTML 规定点 label
 *          任意位置都会激活第一个控件，于是每点一个输入框都会误触复选框
 *        · 样式 `.check input` 是后代选择器，把文本输入框也压成了 16×16，
 *          用户看到的是一堆空的小方块，根本看不见识别出来的内容
 */
import type { ParsedHolding } from '@/services/memory'
import type { DcaPlan } from '@/lib/dca'
import { DCA_PERIODS, describeDca } from '@/lib/dca'

export interface PendingHolding extends ParsedHolding {
  _checked: boolean
  _id: string
  /** 定投不是从截图上读出来的，是用户自己勾的 */
  dca?: DcaPlan
}

defineProps<{ holding: PendingHolding }>()

/** 勾选定投时补一份默认值，取消勾选只关开关、保留填过的数 */
function toggleDca(h: PendingHolding, on: boolean) {
  if (!h.dca) h.dca = { enabled: on, period: 'monthly' }
  else h.dca.enabled = on
}
</script>

<template>
  <div class="card holding-card">
    <!-- 复选框单独一个 label。**绝对不要**把下面的输入框也包进来。 -->
    <label class="check" style="margin-bottom: 8px">
      <input v-model="holding._checked" type="checkbox" />
      <span>录入这一条</span>
    </label>

    <input
      v-model="holding.name"
      type="text"
      class="holding-name"
      style="margin-bottom: 6px"
      placeholder="名称（如 中欧中证全指软件开发指数发起C）"
    />
    <div class="grid2">
      <input v-model.number="holding.shares" type="number" placeholder="股数" />
      <input v-model.number="holding.costPrice" type="number" step="0.001" placeholder="成本价" />
      <input v-model.number="holding.lastPrice" type="number" step="0.001" placeholder="现价" />
      <input v-model.number="holding.marketValue" type="number" placeholder="市值" />
      <input v-model.number="holding.profitAmount" type="number" placeholder="盈亏金额" />
      <input
        v-model.number="holding.profitPct"
        type="number"
        step="0.0001"
        placeholder="盈亏比例(小数)"
      />
    </div>
    <div class="card-meta">
      置信度
      <span
        class="badge"
        :class="holding.confidence >= 0.8 ? 'info' : holding.confidence >= 0.6 ? '' : 'warn'"
      >
        {{ Math.round(holding.confidence * 100) }}%
      </span>
      <span v-if="holding.confidence < 0.6" style="color: var(--warn)"> · 请重点核对 </span>
    </div>

    <!-- 定投：截图里读不出来，得用户自己勾。
         军师需要知道这是持续买入，否则会把自动扣款当成高位补仓来批评。 -->
    <div class="dca-box">
      <label class="check">
        <input
          type="checkbox"
          :checked="holding.dca?.enabled ?? false"
          @change="toggleDca(holding, ($event.target as HTMLInputElement).checked)"
        />
        <span>这是一笔定投</span>
      </label>
      <template v-if="holding.dca?.enabled">
        <div class="grid2" style="margin-top: 6px">
          <select v-model="holding.dca.period">
            <option v-for="p in DCA_PERIODS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
          <input v-model.number="holding.dca.amount" type="number" placeholder="每期金额" />
        </div>
        <div class="card-meta" style="margin-top: 4px">
          {{ describeDca(holding.dca) || '填好周期和金额后生效' }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dca-box {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
</style>
