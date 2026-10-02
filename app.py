"""Streamlit UI for the local OAI T7 grading system."""
from __future__ import annotations

from datetime import datetime
from hashlib import sha256
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
from leaderboard import (
    LOCAL_TZ,
    SPLIT_DISPLAY,
    build_leaderboard,
    build_record,
    load_records,
    new_submission_id,
    ranking_split,
    save_record,
    task_splits,
    utc_now,
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
    if st.button("ĐĂNG NHẬP", type="primary", width="stretch"):
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
            width="stretch",
        )
        if errors:
            st.markdown("**Lỗi:**")
            for message in errors:
                st.write(f"- {message}")
        if warnings:
            st.markdown("**Cảnh báo:**")
            for message in warnings:
                st.write(f"- {message}")


def save_local_submission(team: str, task: str, split: str, uploaded_file, result: dict | None,
                          error: str | None = None) -> dict:
    """Store every local grading in the shared history used by the leaderboard."""
    submitted_at = utc_now()
    record = build_record(
        submission_id=new_submission_id("local", submitted_at),
        source="local",
        team=team,
        task=task,
        split=split,
        submitted_at=submitted_at,
        file_name=uploaded_file.name,
        file_sha256=sha256(uploaded_file.getvalue()).hexdigest(),
        result=result,
        error=error,
    )
    save_record(record)
    return record


def format_time(value: str | None) -> str:
    if not value:
        return "—"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(LOCAL_TZ).strftime("%d/%m/%Y %H:%M")


tab_grade, tab_board = st.tabs(["Chấm điểm", "Bảng xếp hạng"])

with tab_grade:
    with st.container(border=True):
        team_name = st.text_input("Tên đội", key="team_name", help="Dùng để lưu lịch sử và xếp hạng.").strip()
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
        grade_clicked = st.button("CHẤM ĐIỂM", type="primary", width="stretch")

    if grade_clicked:
        if not team_name:
            st.error("Vui lòng nhập tên đội trước khi chấm.")
        elif uploaded_file is None:
            st.error("Vui lòng upload một file .csv hoặc .zip trước khi chấm.")
        else:
            task = selected_task
            config = get_task_config(task)
            try:
                submission_df, internal_name = read_submission(uploaded_file)
                result = grade_submission(task, split, submission_df)
                saved = save_local_submission(team_name, task, split, uploaded_file, result)

                for warning in result["warnings"]:
                    st.warning(warning)

                if not result["valid"]:
                    st.error("❌ Submission không hợp lệ")
                    for error in result["errors"]:
                        st.error(error)
                    show_validation_details(result["stats"], result["errors"], result["warnings"])
                    st.caption(f"Đã lưu vào lịch sử (`{saved['id']}`).")
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

                    board_row = next(row for row in build_leaderboard(load_records(), task) if row["team"] == team_name)
                    rank_split = ranking_split(task)
                    if board_row["rank"]:
                        st.info(f"🏆 Đội **{team_name}** đang xếp hạng **#{board_row['rank']}** "
                                f"(điểm {SPLIT_DISPLAY[rank_split]} tốt nhất: {board_row['best'][rank_split]:.6f}).")
                    else:
                        st.info(f"Đội **{team_name}** chưa được xếp hạng: cần một bài hợp lệ trên {SPLIT_DISPLAY[rank_split]}.")
                    st.caption(f"Đã lưu vào lịch sử (`{saved['id']}`).")

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
                        st.dataframe(classwise, hide_index=True, width="stretch")

                        with st.expander("Confusion Matrix"):
                            st.dataframe(result["confusion_matrix"], width="stretch")
            except SubmissionReadError as exc:
                save_local_submission(team_name, task, split, uploaded_file, None, error=str(exc))
                st.error(f"❌ Không thể đọc submission: {exc}")
            except FileNotFoundError as exc:
                st.error(f"❌ Thiếu file nội bộ: {exc}")
            except Exception as exc:
                st.error(f"❌ Không thể chấm submission: {exc}")


with tab_board:
    all_records = load_records()
    board_task_label = st.selectbox("Tác vụ", options=list(task_labels), key="board_task")
    board_task = task_labels[board_task_label]
    board_splits = task_splits(board_task)
    board_rank_split = ranking_split(board_task)
    tie_rule = "hòa thì so Public Test, rồi đến đội đạt điểm sớm hơn" if "public" in board_splits \
        else "hòa thì đội đạt điểm sớm hơn đứng trước"
    st.caption(f"Xếp hạng theo điểm tốt nhất trên {SPLIT_DISPLAY[board_rank_split]}; {tie_rule}. "
               "Điểm càng cao càng tốt.")

    rows = build_leaderboard(all_records, board_task)
    if rows:
        st.dataframe(
            pd.DataFrame([
                {
                    "Hạng": row["rank"],
                    "Đội": row["team"],
                    **{SPLIT_DISPLAY[s]: row["best"][s] for s in board_splits},
                    "Hợp lệ / Tổng": f"{row['valid_submissions']}/{row['submissions']}",
                    "Lần nộp cuối": format_time(row["last_submitted_at"]),
                }
                for row in rows
            ]),
            hide_index=True,
            width="stretch",
            column_config={SPLIT_DISPLAY[s]: st.column_config.NumberColumn(format="%.6f") for s in board_splits},
        )
    else:
        st.info("Chưa có bài nộp nào cho tác vụ này.")

    st.subheader("Lịch sử nộp bài")
    history = [r for r in reversed(all_records) if r.get("task") == board_task]
    if history:
        st.dataframe(
            pd.DataFrame([
                {
                    "Thời gian": format_time(r["submitted_at"]),
                    "Đội": r["team"],
                    "Tập": SPLIT_DISPLAY.get(r["split"], r["split"]),
                    "Điểm": r["score"],
                    "Hợp lệ": "✅" if r["valid"] else "❌",
                    "Nguồn": r.get("source", ""),
                    "Lỗi": " ".join(r.get("errors") or []),
                }
                for r in history
            ]),
            hide_index=True,
            width="stretch",
            column_config={"Điểm": st.column_config.NumberColumn(format="%.6f")},
        )
    else:
        st.caption("Chưa có lần nộp nào.")
