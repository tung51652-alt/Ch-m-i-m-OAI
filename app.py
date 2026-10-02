"""Streamlit UI for the local OAI T7 grading system."""
from __future__ import annotations

import hmac
import os

import streamlit as st
import pandas as pd

from scoring import (
    METRIC_NAME,
    SubmissionReadError,
    TASKS,
    get_task_config,
    grade_submission,
    read_submission,
)


st.set_page_config(page_title="OAI T7 — Local Grading System", page_icon="📊", layout="centered")


def require_team_password() -> None:
    """Optionally protect a temporary public tunnel with a shared password."""
    expected = os.environ.get("GRADER_PASSWORD", "")
    if not expected or st.session_state.get("grader_authenticated", False):
        return

    st.title("OAI T7 — Team Grader")
    st.caption("Nhập mật khẩu được người tổ chức cung cấp để tiếp tục.")
    supplied = st.text_input("Mật khẩu", type="password")
    if st.button("ĐĂNG NHẬP", type="primary", use_container_width=True):
        if hmac.compare_digest(supplied, expected):
            st.session_state["grader_authenticated"] = True
            st.rerun()
        else:
            st.error("Mật khẩu không đúng.")
    st.stop()


require_team_password()

st.title("OAI T7 — Local Grading System")
st.caption("Hệ thống chấm điểm local cho các tác vụ OAI T7")

task_labels = {
    "Tác vụ 1 — Computer Vision: DeepWeeds": "cv",
    "Tác vụ 2 — NLP: Vietnamese Spam Review Detection": "nlp",
    "Tác vụ 3 — NLP: ViLexNorm": "vilexnorm",
}
split_labels = {"Public Test": "public", "Private Test": "private"}

with st.container(border=True):
    selected_task_label = st.selectbox("Tác vụ", options=list(task_labels))
    selected_task = task_labels[selected_task_label]
    if selected_task == "vilexnorm":
        selected_split_label = st.selectbox("Tập đánh giá", options=["Test Set"], disabled=True)
        split = "test"
    else:
        selected_split_label = st.selectbox("Tập đánh giá", options=list(split_labels))
        split = split_labels[selected_split_label]
    uploaded_file = st.file_uploader(
        "Upload submission",
        type=["csv", "zip"],
        help="CSV trực tiếp hoặc ZIP chứa đúng một file submission.csv/output.csv",
    )
    if uploaded_file is not None:
        st.caption(f"Đã chọn: `{uploaded_file.name}`")
    grade_clicked = st.button("CHẤM ĐIỂM", type="primary", use_container_width=True)


def show_validation_details(stats: dict, errors: list[str], warnings: list[str]) -> None:
    with st.expander("Chi tiết kiểm tra", expanded=bool(errors)):
        st.dataframe(
            pd.DataFrame({
                "Kiểm tra": [
                    "Expected samples",
                    "Submitted samples",
                    "Valid samples",
                    "Missing ID values",
                    "Missing IDs",
                    "Unknown IDs",
                    "Duplicate IDs",
                    "Missing predictions",
                    "Invalid labels",
                ],
                "Giá trị": [
                    stats["expected_samples"],
                    stats["submitted_samples"],
                    stats["valid_samples"],
                    stats["missing_id_values"],
                    stats["missing_ids"],
                    stats["unknown_ids"],
                    stats["duplicate_ids"],
                    stats["missing_predictions"],
                    stats["invalid_labels"],
                ],
            }),
            hide_index=True,
            use_container_width=True,
        )
        if errors:
            st.markdown("**Lỗi:**")
            for message in errors:
                st.write(f"- {message}")
        if warnings:
            st.markdown("**Cảnh báo:**")
            for message in warnings:
                st.write(f"- {message}")


if grade_clicked:
    if uploaded_file is None:
        st.error("Vui lòng upload một file .csv hoặc .zip trước khi chấm.")
    else:
        task = selected_task
        config = get_task_config(task)
        try:
            submission_df, internal_name = read_submission(uploaded_file)
            result = grade_submission(task, split, submission_df)

            for warning in result["warnings"]:
                st.warning(warning)

            if not result["valid"]:
                st.error("❌ Submission không hợp lệ")
                for error in result["errors"]:
                    st.error(error)
                show_validation_details(result["stats"], result["errors"], result["warnings"])
            else:
                st.success("✅ SUBMISSION HỢP LỆ")
                if uploaded_file.name.lower().endswith(".zip"):
                    st.caption(f"Đã đọc `{internal_name}` trong ZIP.")

                score_col, sample_col = st.columns(2)
                metric_name = result.get("metric_name", METRIC_NAME)
                score_col.metric(f"SCORE — {metric_name}", f"{result['score']:.6f}")
                sample_col.metric("Số mẫu hợp lệ", f"{result['stats']['valid_samples']:,}")

                info_col1, info_col2 = st.columns(2)
                info_col1.markdown(f"**Tác vụ:**  \n{config.display_name}")
                info_col1.markdown(f"**Metric:**  \n{metric_name}")
                info_col2.markdown(f"**Test:**  \n{selected_split_label}")
                info_col2.markdown(f"**ID column:**  \n`{config.id_col}`")

                show_validation_details(result["stats"], result["errors"], result["warnings"])

                if task == "vilexnorm":
                    st.subheader("Metrics phụ")
                    secondary = result["secondary_metrics"]
                    columns = st.columns(3)
                    for column, (name, value) in zip(columns, secondary.items()):
                        column.metric(name, f"{value:.6f}")
                    st.caption("Metrics phụ dùng để phân tích, không dùng để xếp hạng. Ground truth không được hiển thị.")
                else:
                    st.subheader("F1 theo lớp")
                    classwise = result["classwise"].copy()
                    for column in ["Precision", "Recall", "F1"]:
                        classwise[column] = classwise[column].map(lambda value: f"{value:.6f}")
                    st.dataframe(classwise, hide_index=True, use_container_width=True)

                    with st.expander("Confusion Matrix"):
                        st.dataframe(result["confusion_matrix"], use_container_width=True)
        except SubmissionReadError as exc:
            st.error(f"❌ Không thể đọc submission: {exc}")
        except FileNotFoundError as exc:
            st.error(f"❌ Thiếu file nội bộ: {exc}")
        except Exception as exc:
            st.error(f"❌ Không thể chấm submission: {exc}")
