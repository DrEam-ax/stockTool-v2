"""采集层：所有源归一到 RawDoc。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterator

from ..models import RawDoc


class Adapter(ABC):
    """一个源一个 adapter，差异全部封在这一层。"""

    name: str = "base"

    @abstractmethod
    def fetch(self, **kwargs) -> Iterator[RawDoc]:
        """产出归一化文档。"""
        raise NotImplementedError

    def describe(self) -> str:
        return f"<{self.name}>"
