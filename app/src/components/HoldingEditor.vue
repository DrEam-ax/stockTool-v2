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

export interface PendingHolding extends ParsedHolding {
  _checked: boolean
  _id: string
}

defineProps<{ holding: PendingHolding }>()
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
  </div>
</template>
