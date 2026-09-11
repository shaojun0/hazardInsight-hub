"""The Encoder/Retriever Protocols are real extension points, not dead code.

Docs 02 defines them as the substitution contract for external implementations. Concrete
classes must therefore honour them, while duck-typed substitutes keep working.
"""

import numpy as np
import pytest
from retrain_cluster.embeddings.base import Encoder
from retrain_cluster.embeddings.openai_compatible import OpenAICompatibleEncoder
from retrain_cluster.embeddings.sccl import SCCLEncoder
from retrain_cluster.embeddings.sentence_transformer import SentenceTransformerEncoder
from retrain_cluster.embeddings.simcse import SimCSEEncoder
from retrain_cluster.retrieval.base import Retriever
from retrain_cluster.retrieval.chroma import ChromaRetriever
from tests.conftest import ExactNeighbors, FixedEncoder

REAL_ENCODERS = [OpenAICompatibleEncoder, SentenceTransformerEncoder, SimCSEEncoder, SCCLEncoder]


@pytest.mark.parametrize("cls", REAL_ENCODERS)
def test_encoder_backends_honour_the_protocol(cls):
    assert issubclass(cls, Encoder)


def test_retriever_backend_honours_the_protocol():
    assert issubclass(ChromaRetriever, Retriever)


@pytest.mark.parametrize("cls", REAL_ENCODERS)
def test_protocol_members_are_present(cls):
    assert callable(cls.encode)


def test_duck_typed_substitutes_still_satisfy_the_protocol():
    """Test doubles in conftest.py must not be forced to inherit."""
    assert isinstance(FixedEncoder(), Encoder)
    assert isinstance(ExactNeighbors(np.zeros((2, 2))), Retriever)


def test_objects_missing_the_member_are_rejected():
    class Unrelated:
        def __call__(self, texts):
            return None

    assert not issubclass(Unrelated, Encoder)
    assert not isinstance(Unrelated(), Retriever)
